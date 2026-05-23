import type { AgentAction } from "../agent/agentState";
import type { Evidence } from "../evidence/evidenceTypes";
import type { RefundTransactionArgs } from "../tools/toolSchemas";

export type PolicyBlockCode =
  | "NO_EVIDENCE"
  | "INSUFFICIENT_EVIDENCE"
  | "LIMIT_EXCEEDED"
  | "INVALID_TRANSACTION_STATE"
  | "DUPLICATE_ACTION"
  | "MISSING_IDEMPOTENCY_KEY"
  | "FORBIDDEN_TOOL"
  | "POISONED_KB_ARTICLE";

export type PolicyDecision =
  | {
      allowed: true;
      reason: string;
    }
  | {
      allowed: false;
      code: PolicyBlockCode;
      reason: string;
    };

export interface RefundPolicyConfig {
  maxAutoRefundAmount: number;
  allowedCurrencies: string[];
}

export interface TransactionSnapshot {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed" | "refunded";
  alreadyRefunded: boolean;
}

export interface RefundPolicyInput {
  args: RefundTransactionArgs;
  transaction: TransactionSnapshot;
  evidence: Evidence[];
  previousActions: AgentAction[];
  policy: RefundPolicyConfig;
}

export function canRefundTransaction(input: RefundPolicyInput): PolicyDecision {
  const { args, transaction, evidence, previousActions, policy } = input;

  if (!args.idempotencyKey || args.idempotencyKey.length < 16) {
    return {
      allowed: false,
      code: "MISSING_IDEMPOTENCY_KEY",
      reason: "High risk action requires a valid idempotency key.",
    };
  }

  const relevantEvidence = evidence.filter((item) => {
    return (
      item.objectId === args.transactionId ||
      item.supports.includes(args.transactionId) ||
      item.fact.includes(args.transactionId)
    );
  });

  if (relevantEvidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: "No evidence found for the target transaction.",
    };
  }

  if (relevantEvidence.length < 2) {
    return {
      allowed: false,
      code: "INSUFFICIENT_EVIDENCE",
      reason: "High risk refund requires at least two evidence records.",
    };
  }

  if (transaction.customerId !== args.customerId) {
    return {
      allowed: false,
      code: "INVALID_TRANSACTION_STATE",
      reason: "Transaction does not belong to the target customer.",
    };
  }

  // alreadyRefunded проверяется до status-сужения, чтобы флаг срабатывал
  // независимо от текущего статуса (внешний процесс мог выставить его раньше).
  // status === "refunded" тоже проверяется здесь — до следующего if, где
  // TypeScript сузит тип до "completed" и ветка станет недостижимой.
  if (transaction.alreadyRefunded || transaction.status === "refunded") {
    return {
      allowed: false,
      code: "DUPLICATE_ACTION",
      reason: "Transaction has already been refunded.",
    };
  }

  if (transaction.status !== "completed") {
    return {
      allowed: false,
      code: "INVALID_TRANSACTION_STATE",
      reason: "Only completed transactions can be refunded.",
    };
  }

  const duplicateAction = previousActions.some((action) => {
    return (
      action.name === "refundTransaction" &&
      action.targetId === args.transactionId &&
      action.status === "success"
    );
  });

  if (duplicateAction) {
    return {
      allowed: false,
      code: "DUPLICATE_ACTION",
      reason: "Refund action was already executed for this transaction.",
    };
  }

  if (args.amount > policy.maxAutoRefundAmount) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      reason: `Refund amount exceeds max auto refund limit: ${policy.maxAutoRefundAmount}.`,
    };
  }

  if (!policy.allowedCurrencies.includes(args.currency)) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      reason: `Currency ${args.currency} is not allowed for automatic refund.`,
    };
  }

  return {
    allowed: true,
    reason: "Refund is allowed by policy and supported by evidence.",
  };
}
