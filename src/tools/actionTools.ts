import { sandboxClient } from "../sandbox/sandboxClient";
import {
  RefundTransactionArgsSchema,
  type RefundTransactionArgs,
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
      "/actions/refund",
      {
        transaction_id: args.transactionId,
        customer_id: args.customerId,
        amount: args.amount,
        currency: args.currency,
        reason: args.reason,
        idempotency_key: args.idempotencyKey,
      },
      { runId: state.runId },
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
      source: "POST /actions/refund",
      status: "success",
      data,
    };
  },
};

export const actionTools = [refundTransactionTool];
