import { z } from "zod";

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  objectId: z.string().min(1),
  fact: z.string().min(10),
  supports: z.string().min(5),
  confidence: z.enum(["low", "medium", "high"]),
  createdAt: z.string().datetime(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
