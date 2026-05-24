import { z } from "zod";
import { EvidenceSchema } from "../evidence/evidenceTypes";

export type RiskLevel = "low" | "medium" | "high";

// ─────────────────────────────────────────────────────────────
// Zod schemas — единственный источник истины.
// TypeScript-типы выводятся из схем через z.infer<>.
// ─────────────────────────────────────────────────────────────

export const AgentActionSchema = z.object({
  name: z.string().min(1),
  targetId: z.string().min(1),
  status: z.enum(["planned", "success", "failed", "blocked"]),
  reason: z.string().min(1),
  /**
   * Идемпотентный ключ для мутирующих операций.
   * Генерируется бэкендом (SHA-256 от caseId + action + targetId),
   * НИКОГДА не делегируется LLM.
   */
  idempotencyKey: z.string().min(16).optional(),
});

export const AgentObservationSchema = z.object({
  type: z.string().min(1),
  source: z.string().min(1),
  status: z.enum(["success", "failed", "blocked"]),
  data: z.unknown().optional(),
  message: z.string().optional(),
});

/**
 * AgentState — центральный объект всего ReAct-пайплайна.
 * Содержит кейс, гипотезу, доказательства, историю шагов и финальный ответ.
 * Свойства с PII (customerId) должны маскироваться перед логированием.
 */
export const AgentStateSchema = z.object({
  runId: z.string().min(1),
  caseId: z.string().min(1),
  dryRun: z.boolean().optional(),
  ticketId: z.string().optional(),
  customerId: z.string().optional(),
  problemSummary: z.string().optional(),
  currentHypothesis: z.string().optional(),
  evidence: z.array(EvidenceSchema),
  observations: z.array(AgentObservationSchema),
  actionsPlanned: z.array(AgentActionSchema),
  actionsDone: z.array(AgentActionSchema),
  toolHistory: z.array(z.unknown()),
  blockedActions: z.array(z.unknown()),
  answer: z.string().optional(),
  isFinished: z.boolean(),
  maxSteps: z.number().int().positive(),
  caseData: z.unknown().optional(),
  /** X-Case-Password forwarded to every sandbox request for locked cases. */
  casePassword: z.string().optional(),
});

// ─────────────────────────────────────────────────────────────
// Публичные TypeScript-типы (выведены из Zod-схем)
// ─────────────────────────────────────────────────────────────

export type AgentAction = z.infer<typeof AgentActionSchema>;
export type AgentObservation = z.infer<typeof AgentObservationSchema>;
export type AgentState = z.infer<typeof AgentStateSchema>;

// ─────────────────────────────────────────────────────────────
// Фабрика начального состояния
// ─────────────────────────────────────────────────────────────

export function createInitialAgentState(input: {
  runId: string;
  caseId: string;
  maxSteps?: number;
  dryRun?: boolean;
}): AgentState {
  return {
    runId: input.runId,
    caseId: input.caseId,
    dryRun: input.dryRun,
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
