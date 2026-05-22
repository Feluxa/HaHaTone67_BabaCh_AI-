import { logEvent } from "../observability/logger";
import { toolRegistry } from "../tools/toolRegistry";
import { RefundTransactionArgsSchema } from "../tools/toolSchemas";
import type { ToolDefinition } from "../tools/toolSchemas";
import type { AgentState } from "../agent/agentState";
import {
  canRefundTransaction,
  type PolicyDecision,
  type TransactionSnapshot,
} from "./rules";

// ─────────────────────────────────────────────────────────────
// Mock transaction store
// Заменяет sandboxClient.get на этапе детерминированного пайплайна.
// Ключ — transactionId. Когда sandboxClient будет подключён,
// эту карту нужно удалить и восстановить вызов API в policyEngine.ts.
// ─────────────────────────────────────────────────────────────

const MOCK_TRANSACTION_STORE: Record<string, TransactionSnapshot> = {
  "TXN-441821": {
    id: "TXN-441821",
    customerId: "CUST-88271",
    status: "completed",
    alreadyRefunded: false,
    amount: 3500,
    currency: "RUB",
  },
};

// ─────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────

export interface PolicyGuardInput {
  tool: ToolDefinition<unknown>;
  args: unknown;
  state: AgentState;
}

/**
 * checkPolicyGuard — точка входа Policy Guard (§12 ARCHITECTURE).
 *
 * Порядок проверок:
 * 1. Whitelist — инструмент зарегистрирован в ToolRegistry.
 * 2. Risk level — Low-risk инструменты пропускаются без проверки.
 * 3. Evidence gate — High/Medium инструменты с requiresEvidence не запускаются без доказательств.
 * 4. Business rules — специфическая политика для каждого High-risk инструмента.
 */
export async function checkPolicyGuard(
  input: PolicyGuardInput,
): Promise<PolicyDecision> {
  const { tool, args, state } = input;

  // ── 1. Whitelist check ────────────────────────────────────
  const allowedTools = toolRegistry.listNames();

  if (!allowedTools.includes(tool.name)) {
    logEvent("warn", "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      code: "FORBIDDEN_TOOL",
    });
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `Tool ${tool.name} is not whitelisted.`,
    };
  }

  // ── 2. Low-risk pass-through ──────────────────────────────
  if (tool.riskLevel === "low") {
    return {
      allowed: true,
      reason: "Low risk read-only tool is allowed.",
    };
  }

  // ── 3. Evidence gate ──────────────────────────────────────
  if (tool.requiresEvidence && state.evidence.length === 0) {
    logEvent("warn", "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      code: "NO_EVIDENCE",
    });
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: "Tool requires evidence, but no evidence was collected.",
    };
  }

  // ── 4. Business rules per tool ────────────────────────────
  if (tool.name === "refundTransaction") {
    const refundArgs = RefundTransactionArgsSchema.parse(args);

    // Mock lookup — заменить на sandboxClient.get при подключении реального API.
    const transaction = MOCK_TRANSACTION_STORE[refundArgs.transactionId];

    if (!transaction) {
      logEvent("warn", "policy.blocked", {
        runId: state.runId,
        tool: tool.name,
        transactionId: refundArgs.transactionId,
        code: "INVALID_TRANSACTION_STATE",
      });
      return {
        allowed: false,
        code: "INVALID_TRANSACTION_STATE",
        reason: `Transaction ${refundArgs.transactionId} not found in store.`,
      };
    }

    const decision = canRefundTransaction({
      args: refundArgs,
      transaction,
      evidence: state.evidence,
      previousActions: state.actionsDone,
      policy: {
        maxAutoRefundAmount: 10_000,
        allowedCurrencies: ["RUB"],
      },
    });

    logEvent(decision.allowed ? "info" : "warn", decision.allowed ? "policy.allowed" : "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      transactionId: refundArgs.transactionId,
      ...(!decision.allowed && { code: decision.code }),
      reason: decision.reason,
    });

    return decision;
  }

  // ── Все прочие High-risk инструменты без явной политики ───
  if (tool.riskLevel === "high") {
    logEvent("warn", "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      code: "FORBIDDEN_TOOL",
    });
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `No explicit policy implemented for high risk tool: ${tool.name}.`,
    };
  }

  // Medium-risk: базовые проверки пройдены
  logEvent("info", "policy.allowed", {
    runId: state.runId,
    tool: tool.name,
    riskLevel: tool.riskLevel,
  });
  return {
    allowed: true,
    reason: "Medium risk tool passed base guard checks.",
  };
}
