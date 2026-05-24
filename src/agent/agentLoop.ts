import { createHash } from "node:crypto";
import { getNextDecision } from "../llm/gigachatClient";
import { logEvent } from "../observability/logger";
import { checkPolicyGuard } from "../policy/policyGuard";
import { extractFromObservation } from "../evidence/evidenceCollector";
import { toolRegistry } from "../tools/toolRegistry";
import {
  getKnowledgeBaseArticleTool,
  getTransactionByIdTool,
  getTransactionsTool,
  getSubscriptionByIdTool,
  searchKnowledgeBaseTool,
  getAtmByIdTool,
  getTransactionAuthorizationsTool,
  getUserHoldsTool,
} from "../tools/investigationTools";
import type { ToolDefinition } from "../tools/toolSchemas";
import type { AgentObservation, AgentState } from "./agentState";
import { buildFallbackAnswer } from "./finalizer";

// ─────────────────────────────────────────────────────────────────────────────
// Idempotency key generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates a deterministic idempotency key for high-risk actions.
 *
 * The key is SHA-256(caseId:action:targetId) so the same action on the same
 * target within the same case always produces the same key, satisfying
 * at-most-once semantics without the LLM needing to supply or invent a value.
 *
 * Per CLAUDE.md §4: "NEVER let the LLM generate the idempotency key."
 */
function generateIdempotencyKey(caseId: string, action: string, targetId: string): string {
  return createHash("sha256")
    .update(`${caseId}:${action}:${targetId}`)
    .digest("hex");
}

// ─────────────────────────────────────────────────────────────────────────────
// State update helpers
// ─────────────────────────────────────────────────────────────────────────────

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

  if (typeof value !== "object" || value === null) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const direct = stringField(record, keys);
  if (direct) return direct;

  for (const nested of Object.values(record)) {
    const found = findFirstString(nested, keys);
    if (found) return found;
  }

  return undefined;
}

function updateStateFromObservation(state: AgentState, observation: { data?: unknown }): void {
  state.customerId =
    state.customerId ??
    findFirstString(observation.data, [
      "user_id",
      "userId",
      "customer_id",
      "customerId",
      "client_id",
      "clientId",
    ]);

  state.ticketId =
    state.ticketId ??
    findFirstString(observation.data, [
      "ticket_id",
      "ticketId",
      "support_ticket_id",
      "supportTicketId",
    ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Observation commitment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commits a tool observation to state:
 *  1. Appends tool name to toolHistory.
 *  2. Appends observation to observations.
 *  3. Updates derived state fields (customerId, ticketId) from response data.
 *  4. Extracts evidence facts and deduplicates by objectId before appending.
 *
 * Used by both the main ReAct loop and the auto-follow-up pipeline so the
 * same bookkeeping runs in exactly one place.
 */
function commitObservation(
  state: AgentState,
  tool: ToolDefinition<unknown>,
  args: unknown,
  observation: AgentObservation,
): void {
  state.toolHistory.push(tool.name);
  state.observations.push(observation);
  updateStateFromObservation(state, observation);

  const newEvidence = extractFromObservation({ state, tool, args, observation });
  const existingObjectIds = new Set(state.evidence.map((ev) => ev.objectId));
  for (const ev of newEvidence) {
    if (!existingObjectIds.has(ev.objectId)) {
      state.evidence.push(ev);
      existingObjectIds.add(ev.objectId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto follow-up
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalises a sandbox list response into a flat array of records.
 * Handles both bare arrays and common wrapper shapes (e.g. `{ articles: [] }`).
 */
function toItems(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(
      (x): x is Record<string, unknown> =>
        typeof x === "object" && x !== null && !Array.isArray(x),
    );
  }
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const record = data as Record<string, unknown>;
    for (const key of [
      "items",
      "articles",
      "alerts",
      "fraud_alerts",
      "atm_operations",
      "operations",
      "authorizations",
      "holds",
      "subscriptions",
      "transactions",
      "results",
      "data",
    ]) {
      const inner = record[key];
      if (Array.isArray(inner)) {
        return inner.filter(
          (x): x is Record<string, unknown> =>
            typeof x === "object" && x !== null && !Array.isArray(x),
        );
      }
    }
  }
  return [];
}

/**
 * Fires automatic follow-up tool calls after certain primary observations,
 * before GigaChat gets control back on the next Reason step.
 *
 * Triggers and their follow-ups:
 *
 * • searchKnowledgeBase → getKnowledgeBaseArticle for every found article.
 *   Each article is first checked by the KB safety guard; poisoned articles
 *   are blocked and recorded as policy_blocked observations instead.
 *
 * • getTransactions → getTransactionById for each anomalous transaction:
 *   declined (auth / limit failures) OR settled card_purchase (posted /
 *   completed) — the two categories most commonly subject to support cases.
 *   Ensures the full (whitelist-filtered) record is in context before any
 *   high-risk action reaches PolicyGuard.
 *
 * • getCustomerProfile → getSubscriptionById for every inactive subscription.
 *   Surfaces activation_error and provider details before the Reason step.
 *
 * • getUserLimits → searchKnowledgeBase("превышение дневного лимита карты")
 *   when no kb_* evidence exists yet. Immediately chains into the
 *   searchKnowledgeBase trigger so each found article is opened in the same pass.
 *
 * • getUserFraudAlerts → searchKnowledgeBase("unauthorized purchase fraud dispute")
 *   when alerts were returned AND no kb_* evidence exists yet. Chains into the
 *   searchKnowledgeBase trigger so each article is opened in the same pass.
 *
 * • getUserHolds → for each hold with a transaction_id:
 *     1. getTransactionById   — full whitelisted transaction record.
 *     2. getTransactionAuthorizations — authorization chain for that transaction.
 *
 * • getUserAtmOperations → four chained follow-ups (all in a single pass):
 *     1. getAtmById        — for every op with an atm_id (address + status).
 *     2. getTransactionById — for every op with a transaction_id not yet in evidence
 *        (full whitelisted record, prompt-injection fields stripped).
 *     2b. getTransactions  — fallback fired once when at least one op has no
 *        transaction_id and no "transactions" observation exists yet; loads the
 *        full list so GigaChat can match the ATM op by amount and date.
 *     3. searchKnowledgeBase("atm cash not dispensed reversal") — once, when no
 *        kb_* evidence exists yet; chains into the searchKnowledgeBase trigger so
 *        each found article is opened in the same pass.
 *
 * All results are committed via commitObservation so evidence deduplication
 * is handled identically to primary tool calls.
 */
async function autoFollowUp(
  state: AgentState,
  primaryToolName: string,
  observation: AgentObservation,
): Promise<void> {
  if (observation.status !== "success") return;

  const { data } = observation;

  // ── searchKnowledgeBase → open each article ──────────────────────────────
  if (primaryToolName === "searchKnowledgeBase") {
    // KB search returns a bare array — toItems() would look for a wrapper key
    // and find nothing. Fall back to toItems() only for unexpected shapes.
    const articles = Array.isArray(data)
      ? (data as unknown[]).filter(
          (x): x is Record<string, unknown> =>
            typeof x === "object" && x !== null && !Array.isArray(x),
        )
      : toItems(data);

    for (const article of articles) {
      const articleId =
        (typeof article["id"] === "string" ? article["id"] : "") ||
        (typeof article["article_id"] === "string" ? article["article_id"] : "");
      if (!articleId) continue;

      // Skip if we already have a full article observation for this id.
      if (
        state.observations.some(
          (obs) => obs.type === "knowledge_base_article" && obs.source.includes(articleId),
        )
      ) continue;

      // KB safety check — poisoned articles must not reach GigaChat context.
      // checkPolicyGuard reads article metadata from state.observations (the
      // searchKnowledgeBase result just recorded above contains tags + risk_level).
      const safetyDecision = await checkPolicyGuard({
        tool: getKnowledgeBaseArticleTool as unknown as ToolDefinition<unknown>,
        args: { articleId },
        state,
      });

      if (!safetyDecision.allowed) {
        logEvent("warn", "auto_follow_up.blocked", {
          runId: state.runId,
          trigger: "searchKnowledgeBase",
          followUp: "getKnowledgeBaseArticle",
          articleId,
          reason: safetyDecision.reason,
        });
        state.observations.push({
          type: "policy_blocked",
          source: "autoFollowUp",
          status: "blocked",
          data: { articleId, code: safetyDecision.code },
          message: safetyDecision.reason,
        });
        continue;
      }

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "searchKnowledgeBase",
        followUp: "getKnowledgeBaseArticle",
        articleId,
      });

      try {
        const followObs = await getKnowledgeBaseArticleTool.execute({ articleId }, state);
        commitObservation(
          state,
          getKnowledgeBaseArticleTool as unknown as ToolDefinition<unknown>,
          { articleId },
          followObs,
        );
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "searchKnowledgeBase",
          followUp: "getKnowledgeBaseArticle",
          articleId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── getTransactions → fetch anomalous transactions ───────────────────────
  //
  // Two criteria trigger an eager getTransactionById follow-up:
  //
  //   1. status === "declined"
  //      The transaction was rejected; the agent needs the full record (decline
  //      reason, response code, limits) to investigate auth / limit issues.
  //
  //   2. kind === "card_purchase" AND status ∈ { "posted", "completed" }
  //      A settled card purchase is the most common subject of support cases
  //      (disputes, duplicate charges, unauthorized purchases).  Fetching it
  //      eagerly ensures PolicyGuard has high-confidence transaction evidence
  //      before evaluating any high-risk action — even when the LLM did not
  //      emit a getTransactionById tool_call of its own.
  //
  // ATM withdrawals and holds are covered by their own dedicated follow-up
  // triggers (getUserAtmOperations, getUserHolds) and are excluded here to
  // prevent double-fetching.
  if (primaryToolName === "getTransactions") {
    const txns = toItems(data);

    for (const txn of txns) {
      const status = txn["status"];
      const kind   = txn["kind"];

      const isDeclined        = status === "declined";
      const isSettledPurchase =
        kind === "card_purchase" &&
        (status === "posted" || status === "completed");

      if (!isDeclined && !isSettledPurchase) continue;

      const txnId =
        (typeof txn["id"] === "string" ? txn["id"] : "") ||
        (typeof txn["transaction_id"] === "string" ? txn["transaction_id"] : "");
      if (!txnId) continue;

      // Skip if we already have a detail observation for this transaction.
      if (
        state.observations.some(
          (obs) => obs.type === "transaction_detail" && obs.source.includes(txnId),
        )
      ) continue;

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "getTransactions",
        followUp: "getTransactionById",
        transactionId: txnId,
        reason: isDeclined ? "declined" : "settled_card_purchase",
      });

      try {
        const followObs = await getTransactionByIdTool.execute(
          { transactionId: txnId },
          state,
        );
        commitObservation(
          state,
          getTransactionByIdTool as unknown as ToolDefinition<unknown>,
          { transactionId: txnId },
          followObs,
        );
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "getTransactions",
          followUp: "getTransactionById",
          transactionId: txnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── getCustomerProfile → fetch each inactive subscription ────────────────
  if (primaryToolName === "getCustomerProfile") {
    const subs = toItems(data);

    for (const sub of subs) {
      if (sub["status"] !== "inactive") continue;

      const subId = typeof sub["id"] === "string" ? sub["id"] : "";
      if (!subId) continue;

      // Skip if we already have a detail observation for this subscription.
      if (
        state.observations.some(
          (obs) => obs.type === "subscription_detail" && obs.source.includes(subId),
        )
      ) continue;

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "getCustomerProfile",
        followUp: "getSubscriptionById",
        subscriptionId: subId,
      });

      try {
        const followObs = await getSubscriptionByIdTool.execute(
          { subscriptionId: subId },
          state,
        );
        commitObservation(
          state,
          getSubscriptionByIdTool as unknown as ToolDefinition<unknown>,
          { subscriptionId: subId },
          followObs,
        );
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "getCustomerProfile",
          followUp: "getSubscriptionById",
          subscriptionId: subId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── getUserLimits → search KB for daily-limit articles ───────────────────
  if (primaryToolName === "getUserLimits") {
    // Only trigger when no KB evidence exists yet — avoids redundant searches
    // when the agent has already found relevant articles in a prior step.
    const hasKbEvidence = state.evidence.some((ev) => ev.objectId.startsWith("kb_"));

    if (!hasKbEvidence) {
      const query = "превышение дневного лимита карты";

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "getUserLimits",
        followUp: "searchKnowledgeBase",
        query,
      });

      try {
        const followObs = await searchKnowledgeBaseTool.execute({ query }, state);
        commitObservation(
          state,
          searchKnowledgeBaseTool as unknown as ToolDefinition<unknown>,
          { query },
          followObs,
        );
        // Chain into the searchKnowledgeBase trigger so each found article is
        // opened immediately — same behaviour as a direct LLM-initiated search.
        await autoFollowUp(state, "searchKnowledgeBase", followObs);
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "getUserLimits",
          followUp: "searchKnowledgeBase",
          query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── getUserAtmOperations → three chained follow-ups ─────────────────────
  if (primaryToolName === "getUserAtmOperations") {
    const ops = toItems(data);

    // ── Sub-action 1: getAtmById for each op that has an atm_id ─────────
    for (const op of ops) {
      const atmId =
        (typeof op["atm_id"] === "string" ? op["atm_id"] : "") ||
        (typeof op["atmId"] === "string" ? op["atmId"] : "") ||
        (typeof op["atm"] === "string" ? op["atm"] : "");
      if (!atmId) continue;

      // Skip if we already have an ATM detail observation for this ATM.
      if (
        state.observations.some(
          (obs) => obs.type === "atm_detail" && obs.source.includes(atmId),
        )
      ) continue;

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "getUserAtmOperations",
        followUp: "getAtmById",
        atmId,
      });

      try {
        const followObs = await getAtmByIdTool.execute({ atmId }, state);
        commitObservation(
          state,
          getAtmByIdTool as unknown as ToolDefinition<unknown>,
          { atmId },
          followObs,
        );
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "getUserAtmOperations",
          followUp: "getAtmById",
          atmId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Sub-action 2: getTransactionById for each op with transaction_id ──
    //
    // Fetches the full (prompt-injection-stripped) transaction record so
    // PolicyGuard has high-confidence transaction evidence before allowing
    // createReversal. Skip if a transaction_detail observation already exists
    // for this id (deduplication mirrors the getTransactions trigger).
    for (const op of ops) {
      const txnId =
        (typeof op["transaction_id"] === "string" ? op["transaction_id"] : "") ||
        (typeof op["txn_id"] === "string" ? op["txn_id"] : "");
      if (!txnId) continue;

      // Skip if we already have a detail observation for this transaction.
      if (
        state.observations.some(
          (obs) => obs.type === "transaction_detail" && obs.source.includes(txnId),
        )
      ) continue;

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "getUserAtmOperations",
        followUp: "getTransactionById",
        transactionId: txnId,
      });

      try {
        const followObs = await getTransactionByIdTool.execute(
          { transactionId: txnId },
          state,
        );
        commitObservation(
          state,
          getTransactionByIdTool as unknown as ToolDefinition<unknown>,
          { transactionId: txnId },
          followObs,
        );
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "getUserAtmOperations",
          followUp: "getTransactionById",
          transactionId: txnId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Sub-action 2b: fallback getTransactions when ops have no transaction_id ─
    //
    // Some ATM operation records do not carry a direct transaction_id link.
    // In that case we load the full transaction list so GigaChat can match the
    // ATM operation to the correct transaction by amount and date on its next
    // Reason step.  The fallback fires at most once per getUserAtmOperations
    // call: only when at least one op lacks a transaction_id, no "transactions"
    // observation exists yet, and state.customerId is already known.
    const someOpHasNoTxnId = ops.some((op) => {
      const txnId =
        (typeof op["transaction_id"] === "string" ? op["transaction_id"] : "") ||
        (typeof op["txn_id"] === "string" ? op["txn_id"] : "");
      return !txnId;
    });

    if (someOpHasNoTxnId && state.customerId) {
      const hasTransactionsObs = state.observations.some(
        (obs) => obs.type === "transactions",
      );

      if (!hasTransactionsObs) {
        const customerId = state.customerId;

        logEvent("info", "auto_follow_up", {
          runId: state.runId,
          trigger: "getUserAtmOperations",
          followUp: "getTransactions",
          customerId,
          reason: "atm_operation missing transaction_id — loading full list for LLM matching",
        });

        try {
          const followObs = await getTransactionsTool.execute(
            { customerId, limit: 50 },
            state,
          );
          commitObservation(
            state,
            getTransactionsTool as unknown as ToolDefinition<unknown>,
            { customerId, limit: 50 },
            followObs,
          );
        } catch (err) {
          logEvent("warn", "auto_follow_up.error", {
            runId: state.runId,
            trigger: "getUserAtmOperations",
            followUp: "getTransactions",
            customerId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── Sub-action 3: searchKnowledgeBase for ATM cash / reversal articles ─
    //
    // Fires once per getUserAtmOperations call when no KB evidence exists yet.
    // Chains into the searchKnowledgeBase trigger so each found article is
    // opened immediately — same pattern as getUserLimits and getUserFraudAlerts.
    const hasKbEvidenceAtm = state.evidence.some((ev) => ev.objectId.startsWith("kb_"));

    if (!hasKbEvidenceAtm) {
      const query = "atm cash not dispensed reversal";

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "getUserAtmOperations",
        followUp: "searchKnowledgeBase",
        query,
      });

      try {
        const followObs = await searchKnowledgeBaseTool.execute({ query }, state);
        commitObservation(
          state,
          searchKnowledgeBaseTool as unknown as ToolDefinition<unknown>,
          { query },
          followObs,
        );
        // Chain: open each found article in the same pass.
        await autoFollowUp(state, "searchKnowledgeBase", followObs);
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "getUserAtmOperations",
          followUp: "searchKnowledgeBase",
          query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── getUserHolds → fetch transaction + authorizations for each hold ────────
  //
  // For each hold that carries a transaction_id we eagerly fetch:
  //   1. getTransactionById — provides high-confidence transaction evidence
  //      required by PolicyGuard before createReversal.
  //   2. getTransactionAuthorizations — surfaces the authorization chain so
  //      the agent can verify whether the hold is legitimate or stale.
  //
  // Skip calls whose observation type is already present for the given id
  // (mirrors the deduplication pattern of getTransactions and getUserAtmOperations).
  if (primaryToolName === "getUserHolds") {
    const holds = toItems(data);

    for (const hold of holds) {
      let txnId =
        (typeof hold["transaction_id"] === "string" ? hold["transaction_id"] : "") ||
        (typeof hold["txn_id"] === "string" ? hold["txn_id"] : "");

      // ── Fallback: resolve txnId from already-loaded transactions ─────────────
      //
      // Some holds arrive without a transaction_id (e.g. restaurant pre-auth).
      // In that case, scan observations of type "transactions" for a transaction
      // whose status === "authorized" and amount matches the hold amount — this
      // is the most reliable heuristic available without an extra API call.
      // If found, eagerly fetch its full record via getTransactionById so it
      // lands in evidence before PolicyGuard checks createReversal.
      if (!txnId && typeof hold["amount"] === "number") {
        const holdAmount = hold["amount"] as number;

        for (const obs of state.observations) {
          if (obs.type !== "transactions") continue;

          // obs.data may be a bare array or a wrapped object — normalise it.
          const txns: unknown[] = Array.isArray(obs.data)
            ? obs.data
            : toItems(obs.data);

          const match = txns.find(
            (t) =>
              typeof t === "object" &&
              t !== null &&
              (t as Record<string, unknown>)["status"] === "authorized" &&
              (t as Record<string, unknown>)["amount"] === holdAmount,
          );

          if (match) {
            const candidateId = (match as Record<string, unknown>)["id"];
            if (typeof candidateId === "string" && candidateId) {
              txnId = candidateId;

              logEvent("info", "auto_follow_up", {
                runId: state.runId,
                trigger: "getUserHolds",
                followUp: "getTransactionById.fallback",
                transactionId: txnId,
                matchedByAmount: holdAmount,
              });

              try {
                const followObs = await getTransactionByIdTool.execute(
                  { transactionId: txnId },
                  state,
                );
                commitObservation(
                  state,
                  getTransactionByIdTool as unknown as ToolDefinition<unknown>,
                  { transactionId: txnId },
                  followObs,
                );
              } catch (err) {
                logEvent("warn", "auto_follow_up.error", {
                  runId: state.runId,
                  trigger: "getUserHolds",
                  followUp: "getTransactionById.fallback",
                  transactionId: txnId,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            break; // one match per hold is sufficient
          }
        }
      }

      if (!txnId) continue;

      // ── 1. getTransactionById ─────────────────────────────────────────────
      if (
        !state.observations.some(
          (obs) => obs.type === "transaction_detail" && obs.source.includes(txnId),
        )
      ) {
        logEvent("info", "auto_follow_up", {
          runId: state.runId,
          trigger: "getUserHolds",
          followUp: "getTransactionById",
          transactionId: txnId,
        });

        try {
          const followObs = await getTransactionByIdTool.execute(
            { transactionId: txnId },
            state,
          );
          commitObservation(
            state,
            getTransactionByIdTool as unknown as ToolDefinition<unknown>,
            { transactionId: txnId },
            followObs,
          );
        } catch (err) {
          logEvent("warn", "auto_follow_up.error", {
            runId: state.runId,
            trigger: "getUserHolds",
            followUp: "getTransactionById",
            transactionId: txnId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── 2. getTransactionAuthorizations ──────────────────────────────────
      if (
        !state.observations.some(
          (obs) =>
            obs.type === "transaction_authorizations" && obs.source.includes(txnId),
        )
      ) {
        logEvent("info", "auto_follow_up", {
          runId: state.runId,
          trigger: "getUserHolds",
          followUp: "getTransactionAuthorizations",
          transactionId: txnId,
        });

        try {
          const followObs = await getTransactionAuthorizationsTool.execute(
            { transactionId: txnId },
            state,
          );
          commitObservation(
            state,
            getTransactionAuthorizationsTool as unknown as ToolDefinition<unknown>,
            { transactionId: txnId },
            followObs,
          );
        } catch (err) {
          logEvent("warn", "auto_follow_up.error", {
            runId: state.runId,
            trigger: "getUserHolds",
            followUp: "getTransactionAuthorizations",
            transactionId: txnId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    // ── 3. searchKnowledgeBase — hold reversal policy article ─────────────
    //
    // Fired once after the holds loop, not per hold — we only need one KB
    // lookup regardless of how many holds were found.  Skip if KB evidence
    // already exists from an earlier step.
    if (!state.evidence.some((ev) => ev.objectId.startsWith("kb_"))) {
      const query = "restaurant authorization hold pending capture";

      logEvent("info", "auto_follow_up", {
        runId: state.runId,
        trigger: "getUserHolds",
        followUp: "searchKnowledgeBase",
        query,
      });

      try {
        const followObs = await searchKnowledgeBaseTool.execute({ query }, state);
        commitObservation(
          state,
          searchKnowledgeBaseTool as unknown as ToolDefinition<unknown>,
          { query },
          followObs,
        );
        // Chain: open each article returned by the search in the same pass.
        await autoFollowUp(state, "searchKnowledgeBase", followObs);
      } catch (err) {
        logEvent("warn", "auto_follow_up.error", {
          runId: state.runId,
          trigger: "getUserHolds",
          followUp: "searchKnowledgeBase",
          query,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── getUserFraudAlerts → search KB for fraud/dispute articles ─────────────
  //
  // Fires only when fraud alerts were actually returned (alerts.length > 0)
  // and no KB evidence exists yet — mirrors the getUserLimits → KB pattern.
  // Chains into the searchKnowledgeBase trigger so each found article is
  // immediately fetched and opened in the same pass.
  if (primaryToolName === "getUserFraudAlerts") {
    const alerts = toItems(data);

    if (alerts.length > 0) {
      const hasKbEvidence = state.evidence.some((ev) => ev.objectId.startsWith("kb_"));

      if (!hasKbEvidence) {
        const query = "unauthorized purchase fraud dispute";

        logEvent("info", "auto_follow_up", {
          runId: state.runId,
          trigger: "getUserFraudAlerts",
          followUp: "searchKnowledgeBase",
          query,
          alertCount: alerts.length,
        });

        try {
          const followObs = await searchKnowledgeBaseTool.execute({ query }, state);
          commitObservation(
            state,
            searchKnowledgeBaseTool as unknown as ToolDefinition<unknown>,
            { query },
            followObs,
          );
          // Chain: open each article found by the search in the same pass.
          await autoFollowUp(state, "searchKnowledgeBase", followObs);
        } catch (err) {
          logEvent("warn", "auto_follow_up.error", {
            runId: state.runId,
            trigger: "getUserFraudAlerts",
            followUp: "searchKnowledgeBase",
            query,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main ReAct loop
// ─────────────────────────────────────────────────────────────────────────────

/**
 * runAgentLoop — основной ReAct-цикл агента (§6 ARCHITECTURE).
 *
 * Каждую итерацию цикл выполняет три шага:
 *   Reason  — запрашивает решение у LLM через {@link getNextDecision}.
 *   Act     — валидирует решение и, при наличии разрешения Policy Guard,
 *             вызывает инструмент через его `execute`.
 *   Observe — сохраняет результат в `state.observations`, извлекает evidence,
 *             затем запускает autoFollowUp для автоматических дочерних вызовов.
 *
 * Функция мутирует `state` напрямую; вызывающий код получает итоговое
 * состояние через тот же указатель — возврат значения не требуется.
 *
 * @param state — текущее состояние агента; должно быть создано фабрикой
 *                {@link createInitialAgentState} до передачи в цикл.
 */
export async function runAgentLoop(state: AgentState): Promise<void> {
  for (let step = 0; step < state.maxSteps; step += 1) {
    // ── Reason: запросить следующее решение от LLM ────────────────────────
    const decision = await getNextDecision(state);

    // §19 ARCHITECTURE: каждое решение LLM должно попадать в трейс.
    // toolName и riskLevel присутствуют только в ветке "tool_call".
    logEvent("info", "llm.decision", {
      runId: state.runId,
      step,
      nextStep: decision.nextStep,
      toolName: decision.nextStep === "tool_call" ? decision.toolName : undefined,
      riskLevel: decision.nextStep === "tool_call" ? decision.riskLevel : undefined,
    });

    // ── Terminal branch: агент сформировал финальный ответ ────────────────
    if (decision.nextStep === "final_answer") {
      state.answer = decision.answer;
      state.isFinished = true;
      break;
    }

    // ── Ожидание данных: продолжаем расследование, не завершаем цикл ──────
    //
    // В отличие от "final_answer", здесь нет `break`: LLM сигнализирует, что
    // ей нужно больше информации, и агент должен попробовать ещё раз.
    if (decision.nextStep === "need_more_info") {
      state.observations.push({
        type: "need_more_info",
        source: "llm",
        status: "failed",
        data: { missingInfo: decision.missingInfo },
        message: decision.reason,
      });
      continue;
    }

    // ── Tool call: Reason → Act → Observe ─────────────────────────────────
    //
    // На данном этапе TypeScript сузил тип decision до дискриминированной
    // ветки "tool_call" — поля toolName и toolArgs гарантированно доступны.

    const { toolName, toolArgs, riskLevel } = decision;

    // ── Act §1: Whitelist — инструмент обязан быть зарегистрирован ────────
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      state.observations.push({
        type: "tool_error",
        source: "toolRegistry",
        status: "failed",
        data: { toolName },
        message: `Tool "${toolName}" is not registered in the tool registry.`,
      });
      logEvent("warn", "tool.not_found", {
        runId: state.runId,
        step,
        toolName,
      });
      continue;
    }

    // ── Act §2: Schema validation — args должны соответствовать inputSchema ─
    //
    // Для refundTransaction backend инжектирует idempotency key до валидации.
    // LLM не знает об этом поле — ключ генерируется детерминированно через
    // SHA-256(caseId:action:targetId), гарантируя at-most-once семантику.
    // (CLAUDE.md §4: "NEVER let the LLM generate the idempotency key.")
    //
    // Используем safeParse (не parse), чтобы получить Result вместо
    // исключения — согласно архитектурному принципу функционального
    // error handling (CLAUDE.md §1).
    const argsToValidate: unknown =
      toolName === "refundTransaction"
        ? {
            ...toolArgs,
            idempotencyKey: generateIdempotencyKey(
              state.caseId,
              toolName,
              typeof toolArgs["transactionId"] === "string" ? toolArgs["transactionId"] : "",
            ),
          }
        : toolArgs;

    const parseResult = tool.inputSchema.safeParse(argsToValidate);
    if (!parseResult.success) {
      state.observations.push({
        type: "tool_error",
        source: toolName,
        status: "failed",
        data: { validationErrors: parseResult.error.format() },
        message: `Invalid arguments for tool "${toolName}": ${JSON.stringify(parseResult.error.format())}`,
      });
      logEvent("warn", "tool.invalid_args", {
        runId: state.runId,
        step,
        toolName,
        errors: parseResult.error.format(),
      });
      continue;
    }

    const validatedArgs = parseResult.data;

    // ── Act §3: Policy Guard — бизнес-правила, evidence gate, whitelist ───
    //
    // checkPolicyGuard возвращает discriminated union PolicyDecision;
    // никакие исключения не выбрасываются на этом уровне.
    const policyDecision = await checkPolicyGuard({ tool, args: validatedArgs, state });

    if (!policyDecision.allowed) {
      state.observations.push({
        type: "policy_blocked",
        source: "policyGuard",
        status: "blocked",
        data: {
          toolName,
          code: policyDecision.code,
          riskLevel,
        },
        message: policyDecision.reason,
      });
      // blockedActions позволяет orchestrator'у и трейсу восстановить,
      // какие действия были отклонены и по какой причине.
      state.blockedActions.push({
        toolName,
        code: policyDecision.code,
        reason: policyDecision.reason,
        step,
      });
      continue;
    }

    // ── Act §4: Execute — инструмент вызывает реальный sandbox-эндпоинт ───
    //
    // Прямые HTTP-вызовы к sandbox запрещены здесь; только через tool.execute.
    if (state.dryRun && tool.riskLevel === "high") {
      const targetId =
        typeof validatedArgs === "object" && validatedArgs !== null
          ? stringField(validatedArgs as Record<string, unknown>, [
              "transactionId",
              "subscriptionId",
              "customerId",
              "userId",
              "ticketId",
            ]) ?? toolName
          : toolName;

      state.actionsPlanned.push({
        name: toolName,
        targetId,
        status: "planned",
        reason: decision.reason,
      });

      state.observations.push({
        type: "action_planned",
        source: toolName,
        status: "blocked",
        data: { toolName, toolArgs: validatedArgs },
        message: "Dry run mode: high-risk action was planned but not executed.",
      });

      continue;
    }

    logEvent("info", "tool.called", {
      runId: state.runId,
      step,
      toolName,
      riskLevel: tool.riskLevel,
    });

    const observation = await tool.execute(validatedArgs, state);

    // ── Observe §1: commit observation + evidence ─────────────────────────
    commitObservation(state, tool, validatedArgs, observation);

    // ── Observe §2: auto follow-up ────────────────────────────────────────
    //
    // For list-returning tools (searchKnowledgeBase, getTransactions,
    // getCustomerProfile) we eagerly fetch individual items so GigaChat
    // sees full detail on its next Reason step without having to emit
    // extra tool_call decisions for each item.
    await autoFollowUp(state, toolName, observation);

    logEvent("info", "tool.observed", {
      runId: state.runId,
      step,
      toolName,
      status: observation.status,
    });
  }

  // ── После цикла: страховочная сетка (finalizer) ───────────────────────
  //
  // Если maxSteps исчерпан или ни один шаг не привёл к final_answer,
  // buildFallbackAnswer формирует человекочитаемый ответ из накопленных
  // evidence и currentHypothesis (см. §12.1 ARCHITECTURE, finalizer.ts).
  if (!state.isFinished) {
    state.answer = buildFallbackAnswer(state);
    state.isFinished = true;
  }
}
