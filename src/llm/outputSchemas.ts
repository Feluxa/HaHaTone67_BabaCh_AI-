import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// §9.1  Схема решения агента
//
// LLM output считается недоверенным вводом.
// Его нельзя передавать в систему без проверки через эту схему.
// ─────────────────────────────────────────────────────────────

export const LlmDecisionSchema = z.discriminatedUnion("nextStep", [
  z.object({
    nextStep: z.literal("tool_call"),
    thoughtSummary: z.string().min(10).max(1000),
    toolName: z.string().min(1),
    // Zod v4: z.record() требует явный ключ; z.record(z.string(), z.unknown())
    // даёт тот же тип Record<string, unknown>, что и z.record(z.unknown()) в v3.
    toolArgs: z.record(z.string(), z.unknown()),
    reason: z.string().min(10).max(1000),
    riskLevel: z.enum(["low", "medium", "high"]),
  }),

  z.object({
    nextStep: z.literal("final_answer"),
    thoughtSummary: z.string().min(10).max(1000),
    answer: z.string().min(20).max(3000),
    evidenceIds: z.array(z.string()).min(1),
  }),

  z.object({
    nextStep: z.literal("need_more_info"),
    thoughtSummary: z.string().min(10).max(1000),
    missingInfo: z.array(z.string()).min(1),
    reason: z.string().min(10).max(1000),
  }),
]);

export type LlmDecision = z.infer<typeof LlmDecisionSchema>;

// ─────────────────────────────────────────────────────────────
// §9.2  Безопасный парсинг ответа LLM
// ─────────────────────────────────────────────────────────────

export function parseLlmDecision(raw: unknown): LlmDecision {
  const result = LlmDecisionSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(
      `Invalid LLM decision schema: ${JSON.stringify(result.error.format())}`,
    );
  }

  return result.data;
}

// ─────────────────────────────────────────────────────────────
// §9.3  Валидация аргументов конкретного инструмента
//
// Схема для аргументов refundTransaction — LLM предлагает эти
// значения, backend валидирует их здесь до передачи в PolicyGuard.
// ─────────────────────────────────────────────────────────────

export const RefundTransactionArgsSchema = z.object({
  transactionId: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
  reason: z
    .string()
    .min(10)
    .max(500),
  idempotencyKey: z.string().min(16),
});

export type RefundTransactionArgs = z.infer<typeof RefundTransactionArgsSchema>;
