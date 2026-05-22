import { z } from "zod";
import { solveCase } from "@/src/agent/orchestrator";

/**
 * Схема входящего запроса к агенту.
 * dryRun=true (по умолчанию) — расследование без реальных мутаций в Sandbox.
 */
const SolveRequestSchema = z.object({
  caseId: z.string().min(1),
  casePassword: z.string().min(1).optional(),
  dryRun: z.boolean().default(true),
});

export async function POST(request: Request): Promise<Response> {
  // Валидируем тело запроса через safeParse — ошибки не бросаем как исключения
  const parseResult = SolveRequestSchema.safeParse(await request.json());

  if (!parseResult.success) {
    return Response.json(
      { error: "Invalid request body", details: parseResult.error.format() },
      { status: 400 },
    );
  }

  try {
    const result = await solveCase(parseResult.data);
    return Response.json(result);
  } catch (reason) {
    const message =
      reason instanceof Error ? reason.message : "Unexpected internal error";
    return Response.json({ error: message }, { status: 500 });
  }
}
