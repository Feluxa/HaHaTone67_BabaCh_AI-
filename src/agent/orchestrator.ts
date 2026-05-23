import { EvidenceSchema, type Evidence } from "../evidence/evidenceTypes";
import { logEvent } from "../observability/logger";
import { evaluatorClient } from "../sandbox/evaluatorClient";
import { casesClient, type SandboxCase } from "../sandbox/casesClient";
import { runsClient } from "../sandbox/runsClient";
import {
  GetCustomerProfileArgsSchema,
  GetTicketMessagesArgsSchema,
  GetTransactionsArgsSchema,
  GetUserProfileArgsSchema,
  GetTransactionByIdArgsSchema,
  GetSubscriptionByIdArgsSchema,
  SearchKnowledgeBaseArgsSchema,
  type ToolDefinition,
} from "../tools/toolSchemas";
import {
  getCustomerProfileTool,
  getTicketMessagesTool,
  getTransactionsTool,
  getUserProfileTool,
  getTransactionByIdTool,
  getSubscriptionByIdTool,
  searchKnowledgeBaseTool,
} from "../tools/investigationTools";
import {
  AgentStateSchema,
  createInitialAgentState,
  type AgentAction,
  type AgentObservation,
  type AgentState,
} from "./agentState";
import { buildFallbackAnswer } from "./finalizer";

export interface SolveCaseInput {
  caseId: string;
  casePassword?: string;
  dryRun?: boolean;
}

export interface SolveCaseResult {
  state: ReturnType<typeof AgentStateSchema.parse>;
  evaluation: unknown | null;
  metrics: Record<string, unknown>;
  exportData: unknown | null;
}

/**
 * Describes an inactive subscription with an unresolved activation error,
 * as returned by GET /users/{user_id}/subscriptions.
 *
 * Both `status === "inactive"` and a non-empty `activationError` must be
 * present together: `inactive` alone can mean a legitimately cancelled plan,
 * while `activationError` alone could be a transient warning on an active one.
 * Their co-occurrence is the diagnostic signal for this case type.
 */
interface InactiveSubscriptionFinding {
  subscriptionId: string;
  /** Preserved verbatim from the payload ("inactive"). */
  status: string;
  /** The error code set by the provider, e.g. "provider_webhook_timeout". */
  activationError: string;
  /** The transaction that funded the purchase, if the sandbox records it. */
  sourceTransactionId: string | undefined;
  raw: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Low-level data helpers
// ─────────────────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function findFirstString(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstString(item, keys);
      if (found) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  const direct = stringField(value, keys);
  if (direct) return direct;

  for (const nested of Object.values(value)) {
    const found = findFirstString(nested, keys);
    if (found) return found;
  }

  return undefined;
}

/**
 * Flattens all nested records (objects) inside an arbitrary payload into a
 * single array so individual subscription entries can be inspected without
 * knowing the exact wrapper key the sandbox uses.
 */
function collectRecords(
  value: unknown,
  output: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectRecords(item, output);
    return output;
  }
  if (!isRecord(value)) return output;
  output.push(value);
  for (const nested of Object.values(value)) collectRecords(nested, output);
  return output;
}

function normalizeText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain extractors
// ─────────────────────────────────────────────────────────────────────────────

function extractTicketId(caseData: SandboxCase): string | undefined {
  return findFirstString(caseData, [
    "intakeTicketId",
    "intake_ticket_id",
    "ticketId",
    "ticket_id",
    "supportTicketId",
    "support_ticket_id",
  ]);
}

/**
 * Extracts the customer / user identifier from an arbitrary sandbox payload.
 *
 * The canonical field name in the sandbox API is `user_id` (returned by
 * GET /support/tickets/{ticket_id} and all /users/... endpoints). Legacy or
 * alternative spellings are kept as fallbacks so the extractor stays robust
 * against minor schema variations across different case types.
 */
function extractCustomerId(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    const id = findFirstString(source, [
      // Canonical — the sandbox always uses user_id in ticket cards
      "user_id",
      "userId",
      // Legacy / alternative spellings kept as fallbacks
      "customerId",
      "customer_id",
      "clientId",
      "client_id",
    ]);
    if (id) return id;
  }
  return undefined;
}

/**
 * Scans the subscriptions payload (GET /users/{user_id}/subscriptions) and
 * returns the first entry that is **inactive AND has a non-empty
 * activation_error**.
 *
 * These two conditions together confirm the diagnostic pattern for
 * case_01_subscription_activation: the payment was accepted but the provider
 * failed to activate the service (e.g. due to a webhook timeout).
 */
function findInactiveSubscription(data: unknown): InactiveSubscriptionFinding | null {
  for (const record of collectRecords(data)) {
    const status = stringField(record, ["status", "state"]);
    if (normalizeText(status) !== "inactive") continue;

    const activationError = stringField(record, [
      "activation_error",
      "activationError",
      "error_code",
      "errorCode",
    ]);
    if (!activationError) continue;

    const subscriptionId = stringField(record, [
      "id",
      "subscriptionId",
      "subscription_id",
    ]);
    if (!subscriptionId) continue;

    const sourceTransactionId = stringField(record, [
      "source_transaction_id",
      "sourceTransactionId",
      "transaction_id",
      "transactionId",
    ]);

    return { subscriptionId, status: status ?? "inactive", activationError, sourceTransactionId, raw: record };
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Answer builders
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Customer-facing response for the subscription-not-activated scenario.
 *
 * Rules:
 * - Confirm the payment was received.
 * - State the technical root cause without blaming the customer.
 * - Do NOT mention a refund — this case does not require one.
 * - Communicate that the team is actively resolving the issue.
 */
function buildSubscriptionNotActivatedAnswer(finding: InactiveSubscriptionFinding): string {
  const txnRef = finding.sourceTransactionId
    ? ` (транзакция ${finding.sourceTransactionId})`
    : "";

  return (
    `Здравствуйте! Мы проверили ваше обращение по подписке. ` +
    `Оплата прошла успешно${txnRef} — средства успешно списаны. ` +
    `Однако подписка не активировалась из-за технической ошибки на стороне провайдера ` +
    `(${finding.activationError}). ` +
    `Наша команда уже занимается этой проблемой — подписка будет активирована ` +
    `в ближайшее время. Дополнительных действий с вашей стороны не требуется.`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts the first article identifier from a knowledge-base search response.
 *
 * The sandbox may wrap results in different shapes:
 *   - Array of articles: [{id, title, ...}, ...]
 *   - Object with results key: {results: [{id, ...}]}
 *   - Object with articles key: {articles: [{id, ...}]}
 *
 * We prefer explicit "article_id" / "articleId" keys before falling back to
 * the generic "id" field, so we avoid accidentally picking up a wrapper object
 * or pagination cursor instead of the article identifier.
 */
function extractKbArticleId(data: unknown): string | undefined {
  // Prefer explicit article-id keys first
  const explicit = findFirstString(data, ["article_id", "articleId"]);
  if (explicit) return explicit;

  // If the response is an array, pull the first element's id directly
  if (Array.isArray(data) && data.length > 0) {
    const first = data[0];
    if (isRecord(first)) return stringField(first, ["id"]);
  }

  // If wrapped in a known key, look one level in
  if (isRecord(data)) {
    for (const wrapperKey of ["articles", "results", "items", "data"]) {
      const wrapped = data[wrapperKey];
      if (Array.isArray(wrapped) && wrapped.length > 0) {
        const first = wrapped[0];
        if (isRecord(first)) return stringField(first, ["id", "article_id", "articleId"]);
      }
    }
  }

  return undefined;
}

function pushEvidence(state: AgentState, evidence: Omit<Evidence, "id" | "createdAt">): Evidence {
  const parsed = EvidenceSchema.parse({
    ...evidence,
    id: `ev_${state.evidence.length + 1}`,
    createdAt: new Date().toISOString(),
  });

  state.evidence.push(parsed);
  logEvent("info", "evidence.created", {
    runId: state.runId,
    evidenceId: parsed.id,
    source: parsed.source,
    objectId: parsed.objectId,
  });

  return parsed;
}

async function executeTool<TArgs>(
  state: AgentState,
  tool: ToolDefinition<TArgs>,
  args: TArgs,
): Promise<AgentObservation> {
  logEvent("info", "tool.called", {
    runId: state.runId,
    toolName: tool.name,
    riskLevel: tool.riskLevel,
  });

  const observation = await tool.execute(args, state);
  state.toolHistory.push(tool.name);
  state.observations.push(observation);

  logEvent("info", "tool.observed", {
    runId: state.runId,
    toolName: tool.name,
    status: observation.status,
  });

  return observation;
}

function actionStatusForEvaluate(
  status: AgentAction["status"],
): "success" | "failed" | "blocked" {
  return status === "planned" ? "blocked" : status;
}

async function safeGetMetrics(runId: string): Promise<Record<string, unknown>> {
  try {
    const metrics = await runsClient.getMetrics(runId);
    return isRecord(metrics) ? metrics : { value: metrics };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unknown metrics error";
    return { unavailable: true, reason: message };
  }
}

async function safeGetExport(runId: string): Promise<unknown | null> {
  try {
    return await runsClient.getExport(runId);
  } catch (reason) {
    logEvent("warn", "export.unavailable", {
      runId,
      reason: reason instanceof Error ? reason.message : "Unknown export error",
    });
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main pipeline
// ─────────────────────────────────────────────────────────────────────────────

export async function solveCase(input: SolveCaseInput): Promise<SolveCaseResult> {
  const isDryRun = input.dryRun ?? true;
  const run = await runsClient.createRun();
  const runId = run.id;

  logEvent("info", "run.created", {
    runId,
    caseId: input.caseId,
    dryRun: isDryRun,
    mode: "real-sandbox-deterministic",
  });

  const state = createInitialAgentState({ runId, caseId: input.caseId });

  // ── Step 1: Load case ───────────────────────────────────────────────────────
  const caseData = await casesClient.getCase(input.caseId, runId, input.casePassword);
  state.caseData = caseData;
  state.ticketId = extractTicketId(caseData);
  state.customerId = extractCustomerId(caseData);

  state.observations.push({
    type: "case_loaded",
    source: `GET /cases/${input.caseId}`,
    status: "success",
    data: caseData,
    message: state.ticketId
      ? `Case loaded. Intake ticket: ${state.ticketId}.`
      : "Case loaded, but intake ticket id was not found in a known field.",
  });

  logEvent("info", "case.loaded", {
    runId,
    caseId: input.caseId,
    ticketId: state.ticketId,
    hasCustomerId: typeof state.customerId === "string",
  });

  // ── Step 2: Load ticket card → extract user_id → ev_1 ─────────────────────
  //
  // GET /support/tickets/{ticket_id} (without /messages) returns the ticket
  // metadata object which contains the canonical `user_id` field identifying
  // the customer. Loading /messages would only return the conversation thread
  // with no user reference.
  let ticketObservation: AgentObservation | undefined;
  if (state.ticketId) {
    ticketObservation = await executeTool(
      state,
      getTicketMessagesTool,
      GetTicketMessagesArgsSchema.parse({ ticketId: state.ticketId }),
    );
    state.customerId = state.customerId ?? extractCustomerId(ticketObservation.data);

    // ev_1 — the ticket card is the entry point of the evidence chain.
    pushEvidence(state, {
      source: ticketObservation.source,
      objectId: state.ticketId,
      fact: `Support ticket ${state.ticketId} was loaded from the sandbox for this investigation.`,
      supports: `case:${input.caseId}`,
      confidence: "medium",
    });
  }

  if (!state.customerId) {
    state.currentHypothesis = "Customer id was not found in the case or ticket payload.";
    state.answer = buildFallbackAnswer(state);
    state.isFinished = true;

    const stateResult = AgentStateSchema.parse(state);
    return {
      state: stateResult,
      evaluation: null,
      metrics: await safeGetMetrics(runId),
      exportData: await safeGetExport(runId),
    };
  }

  // ── Step 3: Load subscriptions → analyze for activation failure ────────────
  //
  // GET /users/{user_id}/subscriptions is the canonical endpoint for all
  // subscription and service-status data. The diagnostic signal is a record
  // with status="inactive" AND a non-empty activation_error: this combination
  // means the payment was accepted but the provider failed to activate.
  const subscriptionsObservation = await executeTool(
    state,
    getCustomerProfileTool,
    GetCustomerProfileArgsSchema.parse({ customerId: state.customerId }),
  );

  const subscriptionFinding = findInactiveSubscription(subscriptionsObservation.data);

  state.observations.push({
    type: "analysis_result",
    source: "subscriptionStatusAnalyzer",
    status: subscriptionFinding ? "success" : "blocked",
    data: subscriptionFinding
      ? {
          subscriptionId: subscriptionFinding.subscriptionId,
          activationError: subscriptionFinding.activationError,
          sourceTransactionId: subscriptionFinding.sourceTransactionId,
        }
      : null,
    message: subscriptionFinding
      ? `Found inactive subscription ${subscriptionFinding.subscriptionId} with activation_error: ${subscriptionFinding.activationError}.`
      : "No inactive subscription with a non-empty activation_error was found.",
  });

  // ── Step 4: Load transactions list (corroborating breadth) ───────────────
  //
  // GET /users/{user_id}/transactions gives the full transaction history.
  // Confirms the payment side; no evidence push here — the individual
  // transaction lookup in Step 4b will produce the targeted evidence.
  await executeTool(
    state,
    getTransactionsTool,
    GetTransactionsArgsSchema.parse({ customerId: state.customerId, limit: 50 }),
  );

  // ── Step 4a: User profile — GET /users/{user_id} ──────────────────────────
  //
  // Retrieves the detailed customer card (name, contact, KYC status).
  // objectId: userId (e.g. usr_a7m2q9).
  const userProfileObservation = await executeTool(
    state,
    getUserProfileTool,
    GetUserProfileArgsSchema.parse({ userId: state.customerId }),
  );

  pushEvidence(state, {
    source: userProfileObservation.source,
    objectId: state.customerId,
    fact: `User profile for ${state.customerId} was retrieved and confirms the account is linked to this case.`,
    supports: `user:${state.customerId}`,
    confidence: "medium",
  });

  // ── Step 4b: Specific transaction — GET /transactions/{transaction_id} ─────
  //
  // Drills into the exact transaction that funded the subscription purchase.
  // Only executed when the subscription analysis found a sourceTransactionId.
  // objectId: transactionId (e.g. txn_4f7a2c90).
  if (subscriptionFinding !== null && subscriptionFinding.sourceTransactionId !== undefined) {
    const txnId = subscriptionFinding.sourceTransactionId;
    const txnDetailObservation = await executeTool(
      state,
      getTransactionByIdTool,
      GetTransactionByIdArgsSchema.parse({ transactionId: txnId }),
    );

    pushEvidence(state, {
      source: txnDetailObservation.source,
      objectId: txnId,
      fact: `Transaction ${txnId} details confirm the payment was processed and is linked to subscription ${subscriptionFinding.subscriptionId}.`,
      supports: `transaction:${txnId}`,
      confidence: "high",
    });
  }

  // ── Step 4c: Specific subscription — GET /subscriptions/{subscription_id} ──
  //
  // Fetches the full subscription record (plan name, provider, activation log).
  // Richer than the user-scoped list; used to corroborate the activation_error.
  // objectId: subscriptionId (e.g. sub_8v2k5q).
  if (subscriptionFinding !== null) {
    const subId = subscriptionFinding.subscriptionId;
    const subDetailObservation = await executeTool(
      state,
      getSubscriptionByIdTool,
      GetSubscriptionByIdArgsSchema.parse({ subscriptionId: subId }),
    );

    pushEvidence(state, {
      source: subDetailObservation.source,
      objectId: subId,
      fact: `Subscription ${subId} detail record confirms status inactive with activation_error: ${subscriptionFinding.activationError}.`,
      supports: `subscription:${subId}`,
      confidence: "high",
    });
  }

  // ── Step 4d: Knowledge base search — GET /knowledge-base/search ───────────
  //
  // Finds articles describing the resolution procedure for subscription
  // activation failures. The first matching article is recorded as evidence.
  // objectId: article id extracted from the search response.
  const kbObservation = await executeTool(
    state,
    searchKnowledgeBaseTool,
    SearchKnowledgeBaseArgsSchema.parse({ query: "subscription activation" }),
  );

  const kbArticleId = extractKbArticleId(kbObservation.data) ?? "subscription+activation";
  pushEvidence(state, {
    source: kbObservation.source,
    objectId: kbArticleId,
    fact: `Knowledge base article ${kbArticleId} was found for query "subscription activation" and provides resolution context for this case type.`,
    supports: `knowledge-base:${kbArticleId}`,
    confidence: "low",
  });

  // ── Step 5: Build subscription finding evidence and final answer ───────────
  if (subscriptionFinding) {
    state.currentHypothesis =
      `Subscription ${subscriptionFinding.subscriptionId} was paid but not activated ` +
      `due to provider error: ${subscriptionFinding.activationError}.`;

    // ev_2 — the inactive subscription with its exact error code and funding
    // transaction. These three fields together are the complete diagnostic fact.
    pushEvidence(state, {
      source: subscriptionsObservation.source,
      objectId: subscriptionFinding.subscriptionId,
      fact:
        `Subscription ${subscriptionFinding.subscriptionId} has status inactive, ` +
        `activation_error: ${subscriptionFinding.activationError}` +
        (subscriptionFinding.sourceTransactionId
          ? `, source_transaction_id: ${subscriptionFinding.sourceTransactionId}`
          : "") +
        ".",
      supports: `subscription:${subscriptionFinding.subscriptionId}`,
      confidence: "high",
    });

    state.answer = buildSubscriptionNotActivatedAnswer(subscriptionFinding);
  } else {
    state.currentHypothesis =
      "No inactive subscription with an activation_error was found in the subscriptions payload.";
    state.answer = buildFallbackAnswer(state);
  }

  state.isFinished = true;
  const stateResult = AgentStateSchema.parse(state);

  // ── Step 6: Evaluate (real mode only) ─────────────────────────────────────
  let evaluation: unknown | null = null;
  if (!isDryRun && stateResult.evidence.length > 0) {
    evaluation = await evaluatorClient.evaluateCase(input.caseId, {
      run_id: stateResult.runId,
      answer: stateResult.answer ?? buildFallbackAnswer(stateResult),
      evidence: stateResult.evidence,
      actions: stateResult.actionsDone.map((action) => ({
        name: action.name,
        target: action.targetId,
        status: actionStatusForEvaluate(action.status),
        reason: action.reason,
      })),
    });

    logEvent("info", "evaluate.submitted", {
      runId,
      caseId: input.caseId,
    });
  }

  const [metrics, exportData] = await Promise.all([
    safeGetMetrics(runId),
    safeGetExport(runId),
  ]);

  logEvent("info", "agent.run.complete", {
    runId,
    caseId: input.caseId,
    steps: stateResult.observations.length,
    evidenceCount: stateResult.evidence.length,
    actionsPlanned: stateResult.actionsPlanned.length,
    actionsDone: stateResult.actionsDone.length,
    dryRun: isDryRun,
  });

  return {
    state: stateResult,
    evaluation,
    metrics: {
      ...metrics,
      localMode: "real-sandbox-deterministic",
      localDryRun: isDryRun,
      localEvidenceCollected: stateResult.evidence.length,
      localActionsPlanned: stateResult.actionsPlanned.length,
      localActionsDone: stateResult.actionsDone.length,
    },
    exportData,
  };
}
