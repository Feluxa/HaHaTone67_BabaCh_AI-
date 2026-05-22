import type { AgentState } from "../agent/agentState";
import type { LlmDecision } from "./outputSchemas";

export interface LlmClient {
  nextDecision(state: AgentState): Promise<LlmDecision>;
}

export class StubLlmClient implements LlmClient {
  async nextDecision(state: AgentState): Promise<LlmDecision> {
    if (state.ticketId && !state.toolHistory.includes("getTicketMessages")) {
      return {
        nextStep: "tool_call",
        thoughtSummary: "The intake ticket should be loaded before deeper investigation.",
        toolName: "getTicketMessages",
        toolArgs: { ticketId: state.ticketId },
        reason: "Ticket messages are the first source of customer-visible facts.",
        riskLevel: "low",
      };
    }

    return {
      nextStep: "need_more_info",
      thoughtSummary: "The real GigaChat client is not connected yet.",
      missingInfo: ["GIGACHAT_API_KEY", "sandbox endpoint map"],
      reason: "The scaffold can validate flow shape, but not solve cases autonomously yet.",
    };
  }
}

export const gigachatClient: LlmClient = new StubLlmClient();
