import { z } from "zod";
import { EvidenceSchema, type Evidence } from "../evidence/evidenceTypes";
import { sandboxClient } from "./sandboxClient";

// ── Public input schema ──────────────────────────────────────────────────────
// Used by callers (orchestrator) — evidence is still full Evidence objects here.
// The client handles serialization to the wire format internally.

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

// ── Wire serializer ──────────────────────────────────────────────────────────

/**
 * Serializes a single Evidence object into the `"type:objectId"` string format
 * required by POST /cases/{case_id}/evaluate.
 *
 * The type prefix is derived from the sandbox ID prefix convention:
 *
 *   usr_*  → "user:{objectId}"
 *   txn_*  → "transaction:{objectId}"
 *   sub_*  → "subscription:{objectId}"
 *   kb_*   → "knowledge_article:{objectId}"
 *   tic_*  → "ticket:{objectId}"
 *   (other) → "{objectId}"   ← bare id, no prefix
 *
 * Example:
 *   objectId "sub_8v2k5q"  → "subscription:sub_8v2k5q"
 *   objectId "txn_4f7a2c90" → "transaction:txn_4f7a2c90"
 *   objectId "usr_a7m2q9"  → "user:usr_a7m2q9"
 *   objectId "tic_7hx2kq"  → "ticket:tic_7hx2kq"
 *   objectId "kb_001"      → "knowledge_article:kb_001"
 */
function evidenceToString(ev: Evidence): string {
  const id = ev.objectId;

  if (id.startsWith("usr_")) return `user:${id}`;
  if (id.startsWith("txn_")) return `transaction:${id}`;
  if (id.startsWith("sub_")) return `subscription:${id}`;
  if (id.startsWith("kb_"))  return `knowledge_article:${id}`;
  if (id.startsWith("tic_")) return `ticket:${id}`;

  return id;
}

// ── Client ───────────────────────────────────────────────────────────────────

export const evaluatorClient = {
  /**
   * Submits a case solution to POST /cases/{case_id}/evaluate.
   *
   * Evidence objects are serialized to strings via `evidenceToString` before
   * the request is sent — the sandbox API expects `evidence: string[]`, not
   * an array of Evidence objects. run_id, answer and actions are forwarded as-is.
   */
  evaluateCase(caseId: string, payload: EvaluatePayload): Promise<unknown> {
    const wire = {
      run_id:   payload.run_id,
      answer:   payload.answer,
      evidence: payload.evidence.map(evidenceToString),
      actions:  payload.actions,
    };

    return sandboxClient.post(`/cases/${caseId}/evaluate`, wire, {
      runId: payload.run_id,
    });
  },
};
