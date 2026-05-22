import type { AgentState } from "../agent/agentState";
import type { LlmDecision } from "../llm/outputSchemas";
import { logEvent } from "./logger";

export function traceDecision(state: AgentState, decision: LlmDecision): void {
  logEvent("info", "llm.decision", {
    runId: state.runId,
    caseId: state.caseId,
    nextStep: decision.nextStep,
    toolName: "toolName" in decision ? decision.toolName : undefined,
  });
}
