import { createHash } from "node:crypto";
import { EvidenceSchema, type Evidence } from "../evidence/evidenceTypes";
import { logEvent } from "../observability/logger";
import { checkPolicyGuard } from "../policy/policyGuard";
import { evaluatorClient } from "../sandbox/evaluatorClient";
import { casesClient, type SandboxCase } from "../sandbox/casesClient";
import { runsClient } from "../sandbox/runsClient";
import { refundTransactionTool } from "../tools/actionTools";
import {
  GetCustomerProfileArgsSchema,
  GetTicketMessagesArgsSchema,
  GetTransactionsArgsSchema,
  RefundTransactionArgsSchema,
  type ToolDefinition,
} from "../tools/toolSchemas";
import {
  getCustomerProfileTool,
  getTicketMessagesTool,
  getTransactionsTool,
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

interface TransactionCandidate {
  id: string;
  customerId?: string;
  amount?: number;
  currency?: string;
  status?: string;
  merchant?: string;
  createdAt?: string;
  alreadyRefunded?: boolean;
  raw: Record<string, unknown>;
}

interface DuplicateFinding {
  original: TransactionCandidate;
  duplicate: TransactionCandidate;
  reason: string;
}

function buildIdempotencyKey(
  caseId: string,
  action: string,
  targetId: string,
): string {
  return createHash("sha256")
    .update(`${caseId}:${action}:${targetId}`)
    .digest("hex")
    .slice(0, 32);
}

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

function numberField(record: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  return undefined;
}

function booleanField(record: Record<string, unknown>, keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return undefined;
}

function findFirstString(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstString(item, keys);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  const direct = stringField(value, keys);
  if (direct) {
    return direct;
  }

  for (const nested of Object.values(value)) {
    const found = findFirstString(nested, keys);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function collectRecords(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRecords(item, output);
    }
    return output;
  }

  if (!isRecord(value)) {
    return output;
  }

  output.push(value);
  for (const nested of Object.values(value)) {
    collectRecords(nested, output);
  }

  return output;
}

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

function extractCustomerId(...sources: unknown[]): string | undefined {
  for (const source of sources) {
    const customerId = findFirstString(source, [
      "customerId",
      "customer_id",
      "clientId",
      "client_id",
      "userId",
      "user_id",
    ]);

    if (customerId) {
      return customerId;
    }
  }

  return undefined;
}

function toTransactionCandidate(record: Record<string, unknown>): TransactionCandidate | null {
  const id = stringField(record, [
    "id",
    "transactionId",
    "transaction_id",
    "operationId",
    "operation_id",
  ]);

  const amount = numberField(record, ["amount", "sum", "value"]);
  if (!id || amount === undefined) {
    return null;
  }

  return {
    id,
    customerId: stringField(record, ["customerId", "customer_id", "clientId", "client_id", "userId", "user_id"]),
    amount,
    currency: stringField(record, ["currency", "currencyCode", "currency_code"])?.toUpperCase(),
    status: stringField(record, ["status", "state"]),
    merchant: stringField(record, ["merchant", "merchantName", "merchant_name", "description", "title"]),
    createdAt: stringField(record, ["createdAt", "created_at", "timestamp", "time", "date"]),
    alreadyRefunded: booleanField(record, ["alreadyRefunded", "already_refunded", "refunded"]),
    raw: record,
  };
}

function extractTransactions(data: unknown): TransactionCandidate[] {
  const byId = new Map<string, TransactionCandidate>();

  for (const record of collectRecords(data)) {
    const candidate = toTransactionCandidate(record);
    if (candidate) {
      byId.set(candidate.id, candidate);
    }
  }

  return Array.from(byId.values());
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function normalizeText(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function findDuplicateTransaction(
  transactions: TransactionCandidate[],
): DuplicateFinding | null {
  const completed = transactions.filter((transaction) => {
    return normalizeText(transaction.status) === "completed" || !transaction.status;
  });

  for (let i = 0; i < completed.length; i += 1) {
    for (let j = i + 1; j < completed.length; j += 1) {
      const first = completed[i];
      const second = completed[j];
      const sameAmount = first.amount === second.amount;
      const sameCurrency = (first.currency ?? "") === (second.currency ?? "");
      const sameMerchant =
        normalizeText(first.merchant) === normalizeText(second.merchant) ||
        !first.merchant ||
        !second.merchant;

      if (!sameAmount || !sameCurrency || !sameMerchant) {
        continue;
      }

      const firstTime = parseTime(first.createdAt);
      const secondTime = parseTime(second.createdAt);
      const secondsBetween =
        firstTime !== undefined && secondTime !== undefined
          ? Math.abs(firstTime - secondTime) / 1000
          : undefined;

      if (secondsBetween !== undefined && secondsBetween > 300) {
        continue;
      }

      const [original, duplicate] =
        firstTime !== undefined &&
        secondTime !== undefined &&
        firstTime > secondTime
          ? [second, first]
          : [first, second];

      return {
        original,
        duplicate,
        reason:
          secondsBetween === undefined
            ? "Found two completed transactions with the same amount, currency and merchant."
            : `Found two completed transactions with the same amount, currency and merchant within ${Math.round(secondsBetween)} seconds.`,
      };
    }
  }

  return null;
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

function actionStatusForEvaluate(status: AgentAction["status"]): "success" | "failed" | "blocked" {
  return status === "planned" ? "blocked" : status;
}

function buildAnswer(input: {
  state: AgentState;
  duplicateFinding: DuplicateFinding | null;
  policyAllowed: boolean | null;
  dryRun: boolean;
}): string {
  const { state, duplicateFinding, policyAllowed, dryRun } = input;

  if (!duplicateFinding) {
    return buildFallbackAnswer(state);
  }

  const amount = duplicateFinding.duplicate.amount;
  const currency = duplicateFinding.duplicate.currency ?? "";

  if (policyAllowed === false) {
    return "Мы проверили обращение и нашли признаки повторной операции, но автоматическое действие заблокировано правилами безопасности. Обращение будет передано специалисту.";
  }

  if (dryRun) {
    return `Проверка завершена в dry-run режиме: найден возможный дубль операции на ${amount} ${currency}. Действие прошло проверку политики, но реальный возврат не выполнялся.`;
  }

  return `Мы нашли повторную операцию на ${amount} ${currency} и инициировали возврат. Деньги вернутся после обработки операции банком.`;
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

  const state = createInitialAgentState({
    runId,
    caseId: input.caseId,
  });

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

  let ticketObservation: AgentObservation | undefined;
  if (state.ticketId) {
    ticketObservation = await executeTool(
      state,
      getTicketMessagesTool,
      GetTicketMessagesArgsSchema.parse({ ticketId: state.ticketId }),
    );
    state.customerId = state.customerId ?? extractCustomerId(ticketObservation.data);

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

  const profileObservation = await executeTool(
    state,
    getCustomerProfileTool,
    GetCustomerProfileArgsSchema.parse({ customerId: state.customerId }),
  );

  pushEvidence(state, {
    source: profileObservation.source,
    objectId: state.customerId,
    fact: `Customer profile ${state.customerId} was loaded and linked to the case investigation.`,
    supports: `customer:${state.customerId}`,
    confidence: "medium",
  });

  const transactionsObservation = await executeTool(
    state,
    getTransactionsTool,
    GetTransactionsArgsSchema.parse({
      customerId: state.customerId,
      limit: 50,
    }),
  );

  const transactions = extractTransactions(transactionsObservation.data);
  const duplicateFinding = findDuplicateTransaction(transactions);

  state.observations.push({
    type: "analysis_result",
    source: "deterministicDuplicateDetector",
    status: duplicateFinding ? "success" : "blocked",
    data: {
      transactionsScanned: transactions.length,
      duplicate: duplicateFinding,
    },
    message: duplicateFinding
      ? duplicateFinding.reason
      : "No duplicate transaction pattern was found by deterministic rules.",
  });

  if (duplicateFinding) {
    state.currentHypothesis = duplicateFinding.reason;
    const duplicate = duplicateFinding.duplicate;
    const original = duplicateFinding.original;

    pushEvidence(state, {
      source: transactionsObservation.source,
      objectId: duplicate.id,
      fact: `Transaction ${duplicate.id} has the same amount, currency and merchant as ${original.id}.`,
      supports: `refundTransaction:${duplicate.id}`,
      confidence: "high",
    });

    pushEvidence(state, {
      source: "deterministicDuplicateDetector",
      objectId: duplicate.id,
      fact: `${duplicateFinding.reason} Candidate duplicate transaction is ${duplicate.id}.`,
      supports: `refundTransaction:${duplicate.id}`,
      confidence: "high",
    });

    const idempotencyKey = buildIdempotencyKey(
      input.caseId,
      "refundTransaction",
      duplicate.id,
    );

    const refundArgs = RefundTransactionArgsSchema.parse({
      transactionId: duplicate.id,
      customerId: duplicate.customerId ?? state.customerId,
      amount: duplicate.amount,
      currency: duplicate.currency ?? "RUB",
      reason: `Duplicate transaction ${duplicate.id} matched original ${original.id} by amount, currency and merchant.`,
      idempotencyKey,
    });

    const guardResult = await checkPolicyGuard({
      tool: refundTransactionTool as ToolDefinition<unknown>,
      args: refundArgs,
      state,
    });

    state.observations.push({
      type: guardResult.allowed ? "policy_allowed" : "policy_blocked",
      source: "policyGuard",
      status: guardResult.allowed ? "success" : "blocked",
      data: {
        tool: "refundTransaction",
        targetId: duplicate.id,
        ...(!guardResult.allowed && { code: guardResult.code }),
      },
      message: guardResult.reason,
    });

    const plannedAction: AgentAction = {
      name: "refundTransaction",
      targetId: duplicate.id,
      status: "planned",
      reason: refundArgs.reason,
      idempotencyKey,
    };
    state.actionsPlanned.push(plannedAction);

    if (guardResult.allowed && !isDryRun) {
      const observation = await refundTransactionTool.execute(refundArgs, state);
      state.observations.push(observation);
    }

    state.answer = buildAnswer({
      state,
      duplicateFinding,
      policyAllowed: guardResult.allowed,
      dryRun: isDryRun,
    });
  } else {
    state.currentHypothesis = "No duplicate transaction was found by deterministic analysis.";
    state.answer = buildAnswer({
      state,
      duplicateFinding,
      policyAllowed: null,
      dryRun: isDryRun,
    });
  }

  state.isFinished = true;
  const stateResult = AgentStateSchema.parse(state);

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
