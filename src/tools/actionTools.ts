import { sandboxClient } from "../sandbox/sandboxClient";
import {
  RefundTransactionArgsSchema,
  type RefundTransactionArgs,
  type CreateDisputeArgs,
  CreateDisputeArgsSchema,
  type CreateReversalArgs,
  CreateReversalArgsSchema,
  type ToolDefinition,
} from "./toolSchemas";

export const refundTransactionTool: ToolDefinition<RefundTransactionArgs> = {
  name: "refundTransaction",
  description: "Refund a completed transaction when policy and evidence allow it.",
  riskLevel: "high",
  requiresEvidence: true,
  requiresPolicyCheck: true,
  inputSchema: RefundTransactionArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.post(
      "/billing/refund",
      {
        transaction_id: args.transactionId,
        customer_id: args.customerId,
        amount: args.amount,
        currency: args.currency,
        reason: args.reason,
        idempotency_key: args.idempotencyKey,
      },
      { runId: state.runId, casePassword: state.casePassword },
    );

    state.actionsDone.push({
      name: "refundTransaction",
      targetId: args.transactionId,
      status: "success",
      reason: args.reason,
      idempotencyKey: args.idempotencyKey,
    });

    return {
      type: "action_result",
      source: "POST /billing/refund",
      status: "success",
      data,
    };
  },
};

/**
 * Creates a dispute for an unauthorized transaction (POST /disputes).
 *
 * High-risk action: requires prior collection of fraud alert evidence
 * (getUserFraudAlerts) and high-confidence transaction evidence
 * (getTransactionById). Both are enforced by PolicyGuard before execution.
 *
 * The sandbox expects { transaction_id, reason } in the request body and
 * returns a dispute record with an id starting with "dis_".
 */
export const createDisputeTool: ToolDefinition<CreateDisputeArgs> = {
  name: "createDispute",
  description:
    "Create a dispute for an unauthorized transaction via POST /disputes. Requires prior fraud alert evidence from getUserFraudAlerts and high-confidence transaction evidence.",
  riskLevel: "high",
  requiresEvidence: true,
  requiresPolicyCheck: true,
  inputSchema: CreateDisputeArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.post(
      "/disputes",
      {
        transaction_id: args.transactionId,
        reason: args.reason,
      },
      { runId: state.runId, casePassword: state.casePassword },
    );

    state.actionsDone.push({
      name: "createDispute",
      targetId: args.transactionId,
      status: "success",
      reason: args.reason,
    });

    return {
      type: "action_result",
      source: "POST /disputes",
      status: "success",
      data,
    };
  },
};

/**
 * Creates a reversal for an ATM operation (POST /billing/reversal).
 *
 * High-risk action: requires prior collection of ATM operation evidence
 * (getUserAtmOperations, objectId starts with "atmop_") and high-confidence
 * transaction evidence (getTransactionById). Both enforced by PolicyGuard.
 *
 * The sandbox expects { transaction_id, reason } and returns a reversal
 * record with an id starting with "rev_".
 */
export const createReversalTool: ToolDefinition<CreateReversalArgs> = {
  name: "createReversal",
  description:
    "Create a reversal for an ATM operation via POST /billing/reversal. Requires prior ATM operation evidence from getUserAtmOperations and high-confidence transaction evidence.",
  riskLevel: "high",
  requiresEvidence: true,
  requiresPolicyCheck: true,
  inputSchema: CreateReversalArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.post(
      "/billing/reversal",
      {
        transaction_id: args.transactionId,
        reason: args.reason,
      },
      { runId: state.runId, casePassword: state.casePassword },
    );

    state.actionsDone.push({
      name: "createReversal",
      targetId: args.transactionId,
      status: "success",
      reason: args.reason,
    });

    return {
      type: "action_result",
      source: "POST /billing/reversal",
      status: "success",
      data,
    };
  },
};

export const actionTools = [refundTransactionTool, createDisputeTool, createReversalTool];
