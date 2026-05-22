import type { AgentObservation, AgentState } from "../agent/agentState";
import type { ToolDefinition } from "../tools/toolSchemas";

export function extractEvidenceFromObservation(input: {
  state: AgentState;
  tool: ToolDefinition<unknown>;
  observation: AgentObservation;
}): void {
  const { state, tool, observation } = input;

  if (observation.status !== "success" || tool.riskLevel !== "low") {
    return;
  }

  state.evidence.push({
    id: `ev_${state.evidence.length + 1}`,
    source: observation.source,
    objectId: observation.source,
    fact: `${tool.name} returned sandbox data for investigation.`,
    supports: tool.name,
    confidence: "medium",
    createdAt: new Date().toISOString(),
  });
}
