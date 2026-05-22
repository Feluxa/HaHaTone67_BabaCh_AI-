import type { AgentState } from "../agent/agentState";
import { toolRegistry } from "../tools/toolRegistry";
import type { ToolDefinition } from "../tools/toolSchemas";
import type { PolicyDecision } from "./rules";
import { checkRefundPolicy } from "./policyEngine";

export interface PolicyGuardInput {
  tool: ToolDefinition<unknown>;
  args: unknown;
  state: AgentState;
}

export async function checkPolicyGuard(input: PolicyGuardInput): Promise<PolicyDecision> {
  const { tool, args, state } = input;
  const allowedTools = toolRegistry.listNames();

  if (!allowedTools.includes(tool.name)) {
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `Tool ${tool.name} is not whitelisted.`,
    };
  }

  if (tool.riskLevel === "low") {
    return {
      allowed: true,
      reason: "Low risk read-only tool is allowed.",
    };
  }

  if (tool.requiresEvidence && state.evidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: "Tool requires evidence, but no evidence was collected.",
    };
  }

  if (tool.name === "refundTransaction") {
    return checkRefundPolicy(args, state);
  }

  if (tool.riskLevel === "high") {
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `No explicit policy implemented for high risk tool: ${tool.name}.`,
    };
  }

  return {
    allowed: true,
    reason: "Medium risk tool passed base guard checks.",
  };
}
