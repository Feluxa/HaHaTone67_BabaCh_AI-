import { z } from "zod";
import { EvidenceSchema } from "../evidence/evidenceTypes";
import { sandboxClient } from "./sandboxClient";

export const EvaluatePayloadSchema = z.object({
  run_id: z.string().min(1),
  answer: z.string().min(20),
  evidence: z.array(EvidenceSchema),
  actions: z.array(
    z.object({
      name: z.string().min(1),
      target: z.string().min(1),
      status: z.enum(["success", "failed", "blocked"]),
      reason: z.string().min(1),
    }),
  ),
});

export type EvaluatePayload = z.infer<typeof EvaluatePayloadSchema>;

export const evaluatorClient = {
  evaluateCase(caseId: string, payload: EvaluatePayload): Promise<unknown> {
    return sandboxClient.post(`/cases/${caseId}/evaluate`, payload, {
      runId: payload.run_id,
    });
  },
};
