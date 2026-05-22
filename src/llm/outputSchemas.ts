import { z } from "zod";

export const LlmDecisionSchema = z.discriminatedUnion("nextStep", [
  z.object({
    nextStep: z.literal("tool_call"),
    thoughtSummary: z.string().min(10).max(1000),
    toolName: z.string().min(1),
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

export function parseLlmDecision(raw: unknown): LlmDecision {
  const result = LlmDecisionSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(
      `Invalid LLM decision schema: ${JSON.stringify(result.error.format())}`,
    );
  }

  return result.data;
}
