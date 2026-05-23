import { logEvent } from "../observability/logger";
import { evaluatorClient } from "../sandbox/evaluatorClient";
import { casesClient, type SandboxCase } from "../sandbox/casesClient";
import { runsClient } from "../sandbox/runsClient";
import { AgentStateSchema, createInitialAgentState } from "./agentState";
import { buildFallbackAnswer } from "./finalizer";
import { runAgentLoop } from "./agentLoop";

export interface SolveCaseInput {
  caseId: string;
  casePassword?: string;
  dryRun?: boolean;
}

export interface SolveCaseResult {
  state: ReturnType<typeof AgentStateSchema.parse>;
  evaluation: unknown | null;
  metrics: Record<string, unknown>;
  exportData: unknown | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findFirstString(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstString(item, keys);
      if (found) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim().length > 0) {
      return field;
    }
  }

  for (const nested of Object.values(value)) {
    const found = findFirstString(nested, keys);
    if (found) return found;
  }

  return undefined;
}

function extractTicketId(caseData: SandboxCase): string | undefined {
  return findFirstString(caseData, [
    "ticket_id",
    "ticketId",
    "intake_ticket_id",
    "intakeTicketId",
    "support_ticket_id",
    "supportTicketId",
  ]);
}

function extractCustomerId(caseData: SandboxCase): string | undefined {
  return findFirstString(caseData, [
    "user_id",
    "userId",
    "customer_id",
    "customerId",
    "client_id",
    "clientId",
  ]);
}

function actionStatusForEvaluate(
  status: "planned" | "success" | "failed" | "blocked",
): "success" | "failed" | "blocked" {
  return status === "planned" ? "blocked" : status;
}

async function safeGetMetrics(runId: string): Promise<Record<string, unknown>> {
  try {
    const metrics = await runsClient.getMetrics(runId);
    return isRecord(metrics) ? metrics : { value: metrics };
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unknown metrics error";
    return { unavailable: true, reason: message };
  }
}

async function safeGetExport(runId: string): Promise<unknown | null> {
  try {
    return await runsClient.getExport(runId);
  } catch (reason) {
    logEvent("warn", "export.unavailable", {
      runId,
      reason: reason instanceof Error ? reason.message : "Unknown export error",
    });
    return null;
  }
}

export async function solveCase(input: SolveCaseInput): Promise<SolveCaseResult> {
  const isDryRun = input.dryRun ?? true;
  const run = await runsClient.createRun();
  const runId = run.id;

  logEvent("info", "run.created", {
    runId,
    caseId: input.caseId,
    dryRun: isDryRun,
    mode: "real-sandbox-agent-loop",
  });

  const state = createInitialAgentState({
    runId,
    caseId: input.caseId,
    dryRun: isDryRun,
  });

  const caseData = await casesClient.getCase(input.caseId, runId, input.casePassword);
  state.caseData = caseData;
  state.ticketId = extractTicketId(caseData);
  state.customerId = extractCustomerId(caseData);

  state.observations.push({
    type: "case_loaded",
    source: `GET /cases/${input.caseId}`,
    status: "success",
    data: caseData,
    message: state.ticketId
      ? `Case loaded. Intake ticket: ${state.ticketId}.`
      : "Case loaded, but intake ticket id was not found in the known fields.",
  });

  logEvent("info", "case.loaded", {
    runId,
    caseId: input.caseId,
    ticketId: state.ticketId,
    customerId: state.customerId,
  });

  await runAgentLoop(state);

  if (!state.isFinished) {
    state.answer = state.answer ?? buildFallbackAnswer(state);
    state.isFinished = true;
  }

  const stateResult = AgentStateSchema.parse(state);

  let evaluation: unknown | null = null;
  if (!isDryRun && stateResult.evidence.length > 0) {
    evaluation = await evaluatorClient.evaluateCase(input.caseId, {
      run_id: stateResult.runId,
      answer: stateResult.answer ?? buildFallbackAnswer(stateResult),
      evidence: stateResult.evidence,
      actions: stateResult.actionsDone.map((action) => ({
        name: action.name,
        target: action.targetId,
        status: actionStatusForEvaluate(action.status),
        reason: action.reason,
      })),
    });

    logEvent("info", "evaluate.submitted", {
      runId,
      caseId: input.caseId,
    });
  }

  const [metrics, exportData] = await Promise.all([
    safeGetMetrics(runId),
    safeGetExport(runId),
  ]);

  logEvent("info", "agent.run.complete", {
    runId,
    caseId: input.caseId,
    steps: stateResult.observations.length,
    evidenceCount: stateResult.evidence.length,
    actionsPlanned: stateResult.actionsPlanned.length,
    actionsDone: stateResult.actionsDone.length,
    dryRun: isDryRun,
  });

  return {
    state: stateResult,
    evaluation,
    metrics: {
      ...metrics,
      localMode: "real-sandbox-agent-loop",
      localDryRun: isDryRun,
      localEvidenceCollected: stateResult.evidence.length,
      localActionsPlanned: stateResult.actionsPlanned.length,
      localActionsDone: stateResult.actionsDone.length,
    },
    exportData,
  };
}
