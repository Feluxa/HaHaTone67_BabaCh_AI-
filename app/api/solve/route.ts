import { z } from "zod";
import { solveCase } from "@/src/agent/orchestrator";

const SolveRequestSchema = z.object({
  caseId: z.string().min(1),
  casePassword: z.string().min(1).optional(),
  dryRun: z.boolean().default(true),
});

export async function POST(request: Request) {
  try {
    const payload = SolveRequestSchema.parse(await request.json());
    const result = await solveCase(payload);

    return Response.json(result);
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : "Unexpected error";

    return Response.json({ error: message }, { status: 400 });
  }
}
