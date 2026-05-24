import type { AgentAction } from "../agent/agentState";
import type { Evidence } from "../evidence/evidenceTypes";
import type { RefundTransactionArgs, CreateDisputeArgs, CreateReversalArgs } from "../tools/toolSchemas";

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
  status: "pending" | "completed" | "posted" | "failed" | "refunded";
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

  // ── Evidence gate ──────────────────────────────────────────────────────────
  //
  // Two independent requirements must both be met:
  //
  //   1. Direct evidence — at least one high-confidence item whose objectId
  //      matches the target transaction.  This proves the specific transaction
  //      was actually inspected (via getTransactionById), not just mentioned in
  //      a list or inferred from a duplicate-pair fact.
  //
  //   2. Investigation breadth — the total evidence count must be ≥ 2.
  //      The second item can be a duplicate-pair record, a KB article, a user
  //      profile fact, etc.  This ensures the agent ran a proper investigation
  //      before reaching for a high-risk action.
  const directEvidence = evidence.filter(
    (item) => item.objectId === args.transactionId && item.confidence === "high",
  );

  if (directEvidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: "No high-confidence evidence found for the target transaction.",
    };
  }

  if (evidence.length < 2) {
    return {
      allowed: false,
      code: "INSUFFICIENT_EVIDENCE",
      reason: "Refund requires at least two evidence records in total.",
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
  // status === "refunded" тоже проверяется здесь, до следующей ветки.
  if (transaction.alreadyRefunded || transaction.status === "refunded") {
    return {
      allowed: false,
      code: "DUPLICATE_ACTION",
      reason: "Transaction has already been refunded.",
    };
  }

  // "posted" is the sandbox equivalent of "completed" — both represent a
  // fully settled transaction eligible for refund.
  if (!["completed", "posted"].includes(transaction.status)) {
    return {
      allowed: false,
      code: "INVALID_TRANSACTION_STATE",
      reason: "Only completed or posted transactions can be refunded.",
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

// ─────────────────────────────────────────────────────────────
// Dispute policy
// ─────────────────────────────────────────────────────────────

export interface CreateDisputePolicyInput {
  args: CreateDisputeArgs;
  evidence: Evidence[];
}

/**
 * Validates whether a createDispute action is permitted by business policy.
 *
 * Two independent evidence requirements must BOTH be satisfied:
 *
 *   1. Transaction evidence — at least one high-confidence item whose objectId
 *      matches the target transactionId. Proves the transaction was individually
 *      inspected via getTransactionById, not merely listed.
 *
 *   2. Fraud alert evidence — at least one item whose objectId starts with
 *      "fraud_". Proves getUserFraudAlerts was called and a fraud signal exists
 *      that justifies opening a dispute.
 */
export function canCreateDispute(input: CreateDisputePolicyInput): PolicyDecision {
  const { args, evidence } = input;

  // ── Requirement 1: high-confidence transaction evidence ───────────────────
  const transactionEvidence = evidence.filter(
    (item) => item.objectId === args.transactionId && item.confidence === "high",
  );

  if (transactionEvidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: `No high-confidence evidence found for transaction ${args.transactionId}. Call getTransactionById first.`,
    };
  }

  // ── Requirement 2: fraud alert evidence ──────────────────────────────────
  const fraudAlertEvidence = evidence.filter((item) =>
    item.objectId.startsWith("fraud_"),
  );

  if (fraudAlertEvidence.length === 0) {
    return {
      allowed: false,
      code: "INSUFFICIENT_EVIDENCE",
      reason:
        "Dispute requires at least one fraud alert as evidence. Call getUserFraudAlerts first.",
    };
  }

  return {
    allowed: true,
    reason:
      "Dispute is allowed: high-confidence transaction evidence and fraud alert evidence are present.",
  };
}

// ─────────────────────────────────────────────────────────────
// Reversal policy
// ─────────────────────────────────────────────────────────────

export interface CreateReversalPolicyInput {
  args: CreateReversalArgs;
  evidence: Evidence[];
}

/**
 * Validates whether a createReversal action is permitted by business policy.
 *
 * Two independent evidence requirements must BOTH be satisfied:
 *
 *   1. Transaction evidence — at least one high-confidence item whose objectId
 *      matches the target transactionId. Proves the transaction was individually
 *      inspected via getTransactionById, not merely referenced in a list.
 *
 *   2. Operational evidence — at least one item whose objectId starts with one
 *      of the following prefixes, covering the three supported reversal paths:
 *        • "atmop_"  — ATM operation (getUserAtmOperations)
 *        • "hold_"   — authorization hold (getUserHolds)
 *        • "auth_"   — authorization record (getTransactionAuthorizations)
 *      Any single matching item satisfies this requirement.
 */
export function canCreateReversal(input: CreateReversalPolicyInput): PolicyDecision {
  const { args, evidence } = input;

  // ── Requirement 1: high-confidence transaction evidence ───────────────────
  const transactionEvidence = evidence.filter(
    (item) => item.objectId === args.transactionId && item.confidence === "high",
  );

  if (transactionEvidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: `No high-confidence evidence found for transaction ${args.transactionId}. Call getTransactionById first.`,
    };
  }

  // ── Requirement 2: ATM operation, hold, or authorization evidence ─────────
  //
  // Covers three reversal paths:
  //   ATM cash not dispensed → getUserAtmOperations (atmop_*)
  //   Authorization hold dispute → getUserHolds (hold_*) or
  //                                 getTransactionAuthorizations (auth_*)
  const operationalEvidence = evidence.filter(
    (item) =>
      item.objectId.startsWith("atmop_") ||
      item.objectId.startsWith("hold_") ||
      item.objectId.startsWith("auth_"),
  );

  if (operationalEvidence.length === 0) {
    return {
      allowed: false,
      code: "INSUFFICIENT_EVIDENCE",
      reason:
        "Reversal requires at least one ATM operation (atmop_*), hold (hold_*), or authorization (auth_*) as evidence. " +
        "Call getUserAtmOperations, getUserHolds, or getTransactionAuthorizations first.",
    };
  }

  return {
    allowed: true,
    reason:
      "Reversal is allowed: high-confidence transaction evidence and operational evidence (ATM operation / hold / authorization) are present.",
  };
}
