import type { Evidence } from "../evidence/evidenceTypes";

export type RiskLevel = "low" | "medium" | "high";

export interface AgentAction {
  name: string;
  targetId: string;
  status: "planned" | "success" | "failed" | "blocked";
  reason: string;
  idempotencyKey?: string;
}

export interface AgentObservation {
  type: string;
  source: string;
  status: "success" | "failed" | "blocked";
  data?: unknown;
  message?: string;
}

export interface AgentState {
  runId: string;
  caseId: string;
  ticketId?: string;
  customerId?: string;
  problemSummary?: string;
  currentHypothesis?: string;
  evidence: Evidence[];
  observations: AgentObservation[];
  actionsPlanned: AgentAction[];
  actionsDone: AgentAction[];
  toolHistory: unknown[];
  blockedActions: unknown[];
  answer?: string;
  isFinished: boolean;
  maxSteps: number;
  caseData?: unknown;
}

export function createInitialAgentState(input: {
  runId: string;
  caseId: string;
  maxSteps?: number;
}): AgentState {
  return {
    runId: input.runId,
    caseId: input.caseId,
    evidence: [],
    observations: [],
    actionsPlanned: [],
    actionsDone: [],
    toolHistory: [],
    blockedActions: [],
    isFinished: false,
    maxSteps: input.maxSteps ?? 12,
  };
}
