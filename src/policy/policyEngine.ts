import { sandboxClient } from "../sandbox/sandboxClient";
import {
  RefundTransactionArgsSchema,
  type RefundTransactionArgs,
  CreateDisputeArgsSchema,
  type CreateDisputeArgs,
  CreateReversalArgsSchema,
  type CreateReversalArgs,
} from "../tools/toolSchemas";
import {
  canRefundTransaction,
  canCreateDispute,
  canCreateReversal,
  type PolicyDecision,
  type TransactionSnapshot,
} from "./rules";
import type { AgentState } from "../agent/agentState";

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

function normalizeTransactionSnapshot(
  raw: unknown,
  fallback: RefundTransactionArgs,
): TransactionSnapshot {
  const record = isRecord(raw) ? raw : {};

  return {
    id:
      stringField(record, ["id", "transactionId", "transaction_id"]) ??
      fallback.transactionId,
    customerId:
      stringField(record, ["customerId", "customer_id", "clientId", "client_id", "userId", "user_id"]) ??
      fallback.customerId,
    amount: numberField(record, ["amount", "sum", "value"]) ?? fallback.amount,
    currency:
      stringField(record, ["currency", "currencyCode", "currency_code"])?.toUpperCase() ??
      fallback.currency,
    status:
      (stringField(record, ["status", "state"]) as TransactionSnapshot["status"] | undefined) ??
      "completed",
    alreadyRefunded:
      record.alreadyRefunded === true ||
      record.already_refunded === true ||
      record.refunded === true ||
      stringField(record, ["status", "state"]) === "refunded",
  };
}

/**
 * Validates createDispute args against business policy.
 *
 * Pure evidence check — no sandbox call required.
 * Delegates to `canCreateDispute` in rules.ts.
 */
export async function checkDisputePolicy(
  args: unknown,
  state: AgentState,
): Promise<PolicyDecision> {
  const disputeArgs: CreateDisputeArgs = CreateDisputeArgsSchema.parse(args);
  return canCreateDispute({
    args: disputeArgs,
    evidence: state.evidence,
  });
}

/**
 * Validates createReversal args against business policy.
 *
 * Pure evidence check — no sandbox call required.
 * Delegates to `canCreateReversal` in rules.ts.
 */
export async function checkReversalPolicy(
  args: unknown,
  state: AgentState,
): Promise<PolicyDecision> {
  const reversalArgs: CreateReversalArgs = CreateReversalArgsSchema.parse(args);
  return canCreateReversal({
    args: reversalArgs,
    evidence: state.evidence,
  });
}

export async function checkRefundPolicy(
  args: unknown,
  state: AgentState,
): Promise<PolicyDecision> {
  const refundArgs: RefundTransactionArgs = RefundTransactionArgsSchema.parse(args);
  const rawTransaction = await sandboxClient.get<unknown>(
    `/transactions/${refundArgs.transactionId}`,
    { runId: state.runId },
  );
  const transaction = normalizeTransactionSnapshot(rawTransaction, refundArgs);

  return canRefundTransaction({
    args: refundArgs,
    transaction,
    evidence: state.evidence,
    previousActions: state.actionsDone,
    policy: {
      maxAutoRefundAmount: 10_000,
      allowedCurrencies: ["RUB"],
    },
  });
}
