import { EvidenceSchema, type Evidence } from "./evidenceTypes";
import type { AgentObservation, AgentState } from "../agent/agentState";
import type { ToolDefinition } from "../tools/toolSchemas";

// ─────────────────────────────────────────────────────────────
// Type guards & data-access helpers
// ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Safely reads a string field; returns "" when absent or non-string. */
function str(record: Record<string, unknown>, key: string): string {
  const v = record[key];
  return typeof v === "string" ? v : "";
}

/**
 * Normalises sandbox list responses.
 * Handles both a bare array and a wrapped object
 * (e.g. `{ subscriptions: [] }`, `{ articles: [] }`, `{ data: [] }`).
 */
function toArray(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) {
    return data.filter(isRecord);
  }
  if (isRecord(data)) {
    for (const key of [
      "items",
      "subscriptions",
      "transactions",
      "articles",
      "limits",
      "results",
      "data",
    ]) {
      const inner = data[key];
      if (Array.isArray(inner)) {
        return inner.filter(isRecord);
      }
    }
  }
  return [];
}

// ─────────────────────────────────────────────────────────────
// Evidence builder
// ─────────────────────────────────────────────────────────────

/**
 * Constructs and validates a single Evidence item.
 *
 * @param baseIndex - position within the current extraction batch (0-based);
 *   combined with `state.evidence.length` to generate a unique sequential id.
 * @param supportsOverride - optional override for the `supports` field;
 *   defaults to `"{toolName}:{objectId}"` when omitted.
 */
function buildEvidence(
  state: AgentState,
  baseIndex: number,
  source: string,
  objectId: string,
  fact: string,
  toolName: string,
  confidence: "low" | "medium" | "high",
  supportsOverride?: string,
): Evidence {
  return EvidenceSchema.parse({
    id: `ev_${state.evidence.length + baseIndex + 1}`,
    source,
    objectId,
    fact,
    supports: supportsOverride ?? `${toolName}:${objectId}`,
    confidence,
    createdAt: new Date().toISOString(),
  });
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

/**
 * Extracts concrete, human-readable facts from a tool observation.
 *
 * Each supported tool has dedicated extraction logic that reads the actual
 * sandbox response fields (amounts, statuses, error messages, etc.) rather
 * than producing a generic "tool returned data" placeholder.
 *
 * The function is pure with respect to `state` — it reads `state.evidence`
 * only to assign sequential IDs and never mutates the state itself.
 * Callers are responsible for deduplication and appending to `state.evidence`.
 *
 * @returns `Evidence[]` — may be empty if the observation carries no useful facts.
 */
export function extractFromObservation(input: {
  state: AgentState;
  tool: ToolDefinition<unknown>;
  args: unknown;
  observation: AgentObservation;
}): Evidence[] {
  const { state, tool, observation } = input;

  if (observation.status !== "success") {
    return [];
  }

  const { data, source } = observation;
  const results: Evidence[] = [];

  /** Pushes a new Evidence into `results`; uses results.length as the batch offset for ID generation. */
  const add = (
    objectId: string,
    fact: string,
    confidence: "low" | "medium" | "high",
    supportsOverride?: string,
  ): void => {
    results.push(
      buildEvidence(state, results.length, source, objectId, fact, tool.name, confidence, supportsOverride),
    );
  };

  switch (tool.name) {
    // ── GET /support/tickets/{ticket_id} ────────────────────────────────────
    case "getTicketMessages": {
      if (!isRecord(data)) break;

      const ticketId = str(data, "id") || str(data, "ticket_id");
      if (!ticketId) break;

      // Prefer explicit summary; fall back to the first message body.
      let summary =
        str(data, "summary") ||
        str(data, "customer_message") ||
        str(data, "subject");

      if (!summary) {
        const messages = data["messages"];
        if (Array.isArray(messages)) {
          const first = messages[0];
          if (isRecord(first)) {
            summary =
              str(first, "text") || str(first, "body") || str(first, "content");
          }
        }
      }

      add(
        ticketId,
        `Клиент сообщает: ${summary || "сообщение без текста"}`,
        "medium",
      );
      break;
    }

    // ── GET /users/{user_id}/subscriptions ───────────────────────────────────
    //
    // Only subscriptions with status=inactive AND a non-empty activation_error
    // qualify as high-confidence evidence — they directly point to the failure root cause.
    case "getCustomerProfile": {
      const subscriptions = toArray(data);
      for (const sub of subscriptions) {
        const subId = str(sub, "id");
        if (!subId) continue;

        const status = str(sub, "status");
        const activationError = str(sub, "activation_error");

        if (status === "inactive" && activationError) {
          const sourceTxnId = str(sub, "source_transaction_id");
          add(
            subId,
            `Подписка ${subId} статус inactive, ошибка активации: ${activationError}, транзакция: ${sourceTxnId || "не указана"}`,
            "high",
          );
        }
      }
      break;
    }

    // ── GET /transactions/{transaction_id} ──────────────────────────────────
    case "getTransactionById": {
      if (!isRecord(data)) break;

      const txnId = str(data, "id") || str(data, "transaction_id");
      if (!txnId) break;

      const amount = data["amount"];
      const amountStr =
        typeof amount === "number"
          ? String(amount)
          : typeof amount === "string"
            ? amount
            : "?";
      const currency = str(data, "currency");
      const status = str(data, "status");
      const merchantName =
        str(data, "merchant_name") || str(data, "merchant") || "неизвестен";

      add(
        txnId,
        `Транзакция ${txnId} на сумму ${amountStr} ${currency} статус ${status}, мерчант ${merchantName}`,
        "high",
      );
      break;
    }

    // ── GET /subscriptions/{subscription_id} ────────────────────────────────
    case "getSubscriptionById": {
      if (!isRecord(data)) break;

      const subId = str(data, "id") || str(data, "subscription_id");
      if (!subId) break;

      const planCode = str(data, "plan_code") || str(data, "plan") || "неизвестен";
      const status = str(data, "status");
      const activationError = str(data, "activation_error") || "нет";

      add(
        subId,
        `Подписка ${subId} план ${planCode} статус ${status}, ошибка: ${activationError}`,
        "high",
      );
      break;
    }

    // ── GET /users/{user_id} ────────────────────────────────────────────────
    case "getUserProfile": {
      if (!isRecord(data)) break;

      const userId = str(data, "id") || str(data, "user_id");
      if (!userId) break;

      const accountStatus =
        str(data, "account_status") || str(data, "status") || "неизвестен";

      add(
        userId,
        `Клиент ${userId} статус аккаунта ${accountStatus}`,
        "medium",
      );
      break;
    }

    // ── GET /users/{user_id}/transactions ────────────────────────────────────
    //
    // Two independent passes over the transaction list:
    //   1. Declined transactions — high-confidence signal for limit/fraud cases.
    //   2. Duplicate detection — pairs with same amount+merchant within 60 s.
    case "getTransactions": {
      const txns = toArray(data);

      for (let i = 0; i < txns.length; i++) {
        const txn = txns[i];
        const txnId = str(txn, "id") || str(txn, "transaction_id");
        if (!txnId) continue;

        // ── Pass 1: declined transactions ──────────────────────────────────
        //
        // Declined transactions are a direct evidence of a limit hit or
        // acquirer refusal. Extract response_code from the metadata_json field
        // (a bank-controlled string, not user input) to surface the exact
        // reason in the trace.
        if (str(txn, "status") === "declined") {
          const amount = txn["amount"];
          const amountStr =
            typeof amount === "number"
              ? String(amount)
              : typeof amount === "string"
                ? amount
                : "?";
          const currency = str(txn, "currency");

          let responseCode = "неизвестен";
          const metadataJson = str(txn, "metadata_json");
          if (metadataJson) {
            try {
              const meta: unknown = JSON.parse(metadataJson);
              if (isRecord(meta)) {
                responseCode = str(meta, "response_code") || responseCode;
              }
            } catch {
              // metadata_json is not valid JSON — keep default
            }
          }

          add(
            txnId,
            `Транзакция ${txnId} на сумму ${amountStr} ${currency} отклонена: ${responseCode}`,
            "high",
          );
          // Declined transactions cannot be duplicate charges — skip pass 2.
          continue;
        }

        // ── Pass 2: duplicate charge detection ─────────────────────────────
        const txnAmount = Number(txn["amount"]);
        if (isNaN(txnAmount)) continue;

        const txnMerchant =
          str(txn, "merchant_name") || str(txn, "merchant");
        if (!txnMerchant) continue;

        const txnCreatedAt =
          str(txn, "created_at") ||
          str(txn, "timestamp") ||
          str(txn, "date");
        const txnTime = txnCreatedAt ? new Date(txnCreatedAt).getTime() : NaN;
        if (isNaN(txnTime)) continue;

        for (let j = i + 1; j < txns.length; j++) {
          const other = txns[j];
          const otherId = str(other, "id") || str(other, "transaction_id");
          if (!otherId) continue;

          const otherAmount = Number(other["amount"]);
          if (isNaN(otherAmount)) continue;

          const otherMerchant =
            str(other, "merchant_name") || str(other, "merchant");
          const otherCreatedAt =
            str(other, "created_at") ||
            str(other, "timestamp") ||
            str(other, "date");
          const otherTime = otherCreatedAt
            ? new Date(otherCreatedAt).getTime()
            : NaN;

          if (isNaN(otherTime)) continue;

          const diffSeconds = Math.abs(txnTime - otherTime) / 1000;

          if (
            txnAmount === otherAmount &&
            txnMerchant === otherMerchant &&
            diffSeconds < 60
          ) {
            const diffRounded = Math.round(diffSeconds);
            add(
              txnId,
              `Возможный дубликат транзакции ${txnId}: та же сумма и мерчант что у ${otherId}, разница ${diffRounded} сек`,
              "high",
            );
            add(
              otherId,
              `Возможный дубликат транзакции ${otherId}: та же сумма и мерчант что у ${txnId}, разница ${diffRounded} сек`,
              "high",
            );
          }
        }
      }
      break;
    }

    // ── GET /knowledge-base/search?q={query} ────────────────────────────────
    //
    // Search results are low-confidence: only a title/snippet is available.
    // The agent must open each article via getKnowledgeBaseArticle to promote
    // it to usable evidence.
    case "searchKnowledgeBase": {
      const articles = toArray(data);
      for (const article of articles) {
        const articleId = str(article, "id") || str(article, "article_id");
        if (!articleId) continue;

        const title = str(article, "title") || "без заголовка";
        add(
          articleId,
          `Найдена статья базы знаний ${articleId}: ${title}`,
          "low",
          // Explicit reminder in the supports field: search results are stubs;
          // the agent MUST follow up with getKnowledgeBaseArticle for each article.
          `searchKnowledgeBase:${articleId} → требует getKnowledgeBaseArticle`,
        );
      }
      break;
    }

    // ── GET /knowledge-base/articles/{article_id} ────────────────────────────
    //
    // Opening the full article body qualifies as evidence (medium confidence)
    // per evaluator rules — snippets from search results do not.
    case "getKnowledgeBaseArticle": {
      if (!isRecord(data)) break;

      const articleId = str(data, "id") || str(data, "article_id");
      if (!articleId) break;

      const title = str(data, "title") || "без заголовка";
      const content =
        str(data, "content") || str(data, "body") || str(data, "text");
      const snippet = content.slice(0, 200);

      add(
        articleId,
        `Статья ${articleId} '${title}': ${snippet || "содержимое недоступно"}`,
        "medium",
      );
      break;
    }

    // ── GET /users/{user_id}/limits ──────────────────────────────────────────
    //
    // Each limit record documents the configured ceiling and how much of it
    // has been consumed. High confidence: this is authoritative bank data used
    // directly to explain declined transactions.
    case "getUserLimits": {
      const limits = toArray(data);
      for (const lim of limits) {
        const limId = str(lim, "id");
        if (!limId) continue;

        const limitType = str(lim, "limit_type") || str(lim, "type") || "неизвестен";

        const amount = lim["amount"];
        const amountStr =
          typeof amount === "number"
            ? String(amount)
            : typeof amount === "string"
              ? amount
              : "?";

        const usedAmount = lim["used_amount"];
        const usedAmountStr =
          typeof usedAmount === "number"
            ? String(usedAmount)
            : typeof usedAmount === "string"
              ? usedAmount
              : "?";

        const currency = str(lim, "currency");

        add(
          limId,
          `Лимит ${limId}: тип ${limitType}, лимит ${amountStr} ${currency}, использовано ${usedAmountStr}`,
          "high",
        );
      }
      break;
    }

    // ── Fallback: all other tools ────────────────────────────────────────────
    default: {
      add(tool.name, `${tool.name} вернул данные`, "low");
      break;
    }
  }

  return results;
}
