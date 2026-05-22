import { casesClient } from "../sandbox/casesClient";
import { evaluatorClient } from "../sandbox/evaluatorClient";
import { runsClient } from "../sandbox/runsClient";
import { createInitialAgentState } from "./agentState";
import { runAgentLoop } from "./agentLoop";

export interface SolveCaseInput {
  caseId: string;
  casePassword?: string;
  dryRun?: boolean;
}

export async function solveCase(input: SolveCaseInput) {
  const run = await runsClient.createRun();
  const caseData = await casesClient.getCase(input.caseId, run.id, input.casePassword);
  const state = createInitialAgentState({
    runId: run.id,
    caseId: input.caseId,
  });

  state.caseData = caseData;
  state.ticketId = caseData.intakeTicketId ?? caseData.ticket_id;
  state.customerId = caseData.customerId ?? caseData.customer_id;

  await runAgentLoop(state);

  if (!input.dryRun) {
    await evaluatorClient.evaluateCase(input.caseId, {
      run_id: state.runId,
      answer: state.answer ?? "",
      evidence: state.evidence,
      actions: state.actionsDone.map((action) => ({
        name: action.name,
        target: action.targetId,
        status:
          action.status === "planned" ? ("blocked" as const) : action.status,
        reason: action.reason,
      })),
    });
  }

  const [metrics, exportData] = await Promise.all([
    runsClient.getMetrics(state.runId),
    runsClient.getExport(state.runId),
  ]);

  return {
    state,
    metrics,
    exportData,
  };
}
