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
 *   lim_*  → "limit:{objectId}"
 *   card_* → "card:{objectId}"
 *   acc_*  → "account:{objectId}"
 *   (other) → "{objectId}"   ← bare id, no prefix
 *
 * Example:
 *   objectId "sub_8v2k5q"   → "subscription:sub_8v2k5q"
 *   objectId "txn_4f7a2c90" → "transaction:txn_4f7a2c90"
 *   objectId "usr_a7m2q9"   → "user:usr_a7m2q9"
 *   objectId "tic_7hx2kq"   → "ticket:tic_7hx2kq"
 *   objectId "kb_001"       → "knowledge_article:kb_001"
 *   objectId "lim_abc123"   → "limit:lim_abc123"
 *   objectId "card_xyz789"  → "card:card_xyz789"
 *   objectId "acc_def456"   → "account:acc_def456"
 */
function evidenceToString(ev: Evidence): string {
  const id = ev.objectId;

  if (id.startsWith("usr_"))  return `user:${id}`;
  if (id.startsWith("txn_"))  return `transaction:${id}`;
  if (id.startsWith("sub_"))  return `subscription:${id}`;
  if (id.startsWith("kb_"))   return `knowledge_article:${id}`;
  if (id.startsWith("tic_"))  return `ticket:${id}`;
  if (id.startsWith("lim_"))  return `limit:${id}`;
  if (id.startsWith("card_")) return `card:${id}`;
  if (id.startsWith("acc_"))  return `account:${id}`;

  return id;
}

// ── Action serializer ────────────────────────────────────────────────────────

/**
 * Serializes a single action into the `"name:targetId"` string format
 * required by POST /cases/{case_id}/evaluate.
 *
 * Example:
 *   { name: "refundTransaction", target: "txn_8e74b16c", ... }
 *   → "refundTransaction:txn_8e74b16c"
 */
function actionToString(action: EvaluatePayload["actions"][number]): string {
  return `${action.name}:${action.target}`;
}

// ── Client ───────────────────────────────────────────────────────────────────

export const evaluatorClient = {
  /**
   * Submits a case solution to POST /cases/{case_id}/evaluate.
   *
   * Both evidence and actions are serialized to strings before the request is
   * sent — the sandbox API expects `evidence: string[]` and `actions: string[]`.
   * Evidence uses `evidenceToString` (type-prefixed objectId); actions use
   * `actionToString` ("name:targetId").
   */
  evaluateCase(caseId: string, payload: EvaluatePayload): Promise<unknown> {
    const wire = {
      run_id:   payload.run_id,
      answer:   payload.answer,
      evidence: payload.evidence.map(evidenceToString),
      actions:  payload.actions.map(actionToString),
    };

    return sandboxClient.post(`/cases/${caseId}/evaluate`, wire, {
      runId: payload.run_id,
    });
  },
};
