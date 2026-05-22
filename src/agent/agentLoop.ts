import { extractEvidenceFromObservation } from "../evidence/evidenceCollector";
import { gigachatClient } from "../llm/gigachatClient";
import { traceDecision } from "../observability/trace";
import { checkPolicyGuard } from "../policy/policyGuard";
import { toolRegistry } from "../tools/toolRegistry";
import type { AgentState } from "./agentState";
import { buildFallbackAnswer } from "./finalizer";

export async function runAgentLoop(state: AgentState): Promise<AgentState> {
  for (let step = 0; step < state.maxSteps; step += 1) {
    const decision = await gigachatClient.nextDecision(state);
    traceDecision(state, decision);

    if (decision.nextStep === "tool_call") {
      const tool = toolRegistry.get(decision.toolName);

      if (!tool) {
        state.observations.push({
          type: "tool_error",
          source: decision.toolName,
          status: "failed",
          message: `Unknown tool: ${decision.toolName}`,
        });
        continue;
      }

      const args = tool.inputSchema.parse(decision.toolArgs);
      const guardResult = await checkPolicyGuard({ tool, args, state });

      if (!guardResult.allowed) {
        state.blockedActions.push({ toolName: tool.name, guardResult });
        state.observations.push({
          type: "blocked_action",
          source: tool.name,
          status: "blocked",
          message: guardResult.reason,
        });
        continue;
      }

      const observation = await tool.execute(args, state);
      state.toolHistory.push(tool.name);
      state.observations.push(observation);
      extractEvidenceFromObservation({ state, tool, observation });
      continue;
    }

    if (decision.nextStep === "final_answer") {
      state.answer = decision.answer;
      state.isFinished = true;
      break;
    }

    state.observations.push({
      type: "need_more_info",
      source: "llm",
      status: "blocked",
      data: decision.missingInfo,
      message: decision.reason,
    });
    break;
  }

  if (!state.isFinished) {
    state.answer = buildFallbackAnswer(state);
  }

  return state;
}
