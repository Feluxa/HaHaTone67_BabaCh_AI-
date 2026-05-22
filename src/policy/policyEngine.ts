import { sandboxClient } from "../sandbox/sandboxClient";
import {
  RefundTransactionArgsSchema,
  type RefundTransactionArgs,
} from "../tools/toolSchemas";
import {
  canRefundTransaction,
  type PolicyDecision,
  type TransactionSnapshot,
} from "./rules";
import type { AgentState } from "../agent/agentState";

export async function checkRefundPolicy(
  args: unknown,
  state: AgentState,
): Promise<PolicyDecision> {
  const refundArgs: RefundTransactionArgs = RefundTransactionArgsSchema.parse(args);
  const transaction = await sandboxClient.get<TransactionSnapshot>(
    `/transactions/${refundArgs.transactionId}`,
    { runId: state.runId },
  );

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
