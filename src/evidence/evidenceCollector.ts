import type { AgentObservation, AgentState } from "../agent/agentState";
import type { ToolDefinition } from "../tools/toolSchemas";
import { EvidenceSchema } from "./evidenceTypes";

const SANDBOX_ID_PATTERN = /\b(?:usr|txn|sub|tic|kb)_[A-Za-z0-9_-]+\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function idPatternForPrefix(prefix: string): RegExp {
  return new RegExp(`\\b${prefix}_[A-Za-z0-9_-]+\\b`);
}

function findIdInValue(value: unknown, preferredPrefix?: string): string | undefined {
  const preferredPattern = preferredPrefix ? idPatternForPrefix(preferredPrefix) : null;

  if (typeof value === "string") {
    return value.match(preferredPattern ?? SANDBOX_ID_PATTERN)?.[0];
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findIdInValue(item, preferredPrefix);
      if (found) return found;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;

  for (const key of [
    "id",
    "user_id",
    "transaction_id",
    "subscription_id",
    "ticket_id",
    "article_id",
  ]) {
    const field = value[key];
    if (typeof field === "string") {
      const found = field.match(preferredPattern ?? SANDBOX_ID_PATTERN)?.[0];
      if (found) return found;
    }
  }

  for (const nested of Object.values(value)) {
    const found = findIdInValue(nested, preferredPrefix);
    if (found) return found;
  }

  return undefined;
}

function preferredPrefixForObservation(observation: AgentObservation): string | undefined {
  if (observation.type.includes("subscription")) return "sub";
  if (observation.type.includes("transaction")) return "txn";
  if (observation.type.includes("ticket")) return "tic";
  if (observation.type.includes("knowledge")) return "kb";
  if (observation.type.includes("user") || observation.type.includes("customer")) return "usr";

  return undefined;
}

function objectIdFromObservation(observation: AgentObservation): string {
  const preferredPrefix = preferredPrefixForObservation(observation);

  return (
    findIdInValue(observation.data, preferredPrefix) ??
    observation.source.match(
      preferredPrefix ? idPatternForPrefix(preferredPrefix) : SANDBOX_ID_PATTERN,
    )?.[0] ??
    findIdInValue(observation.data) ??
    observation.source.match(SANDBOX_ID_PATTERN)?.[0] ??
    observation.source
  );
}

export function extractEvidenceFromObservation(input: {
  state: AgentState;
  tool: ToolDefinition<unknown>;
  observation: AgentObservation;
}): void {
  const { state, tool, observation } = input;

  if (observation.status !== "success" || tool.riskLevel !== "low") {
    return;
  }

  const objectId = objectIdFromObservation(observation);
  const evidence = EvidenceSchema.parse({
    id: `ev_${state.evidence.length + 1}`,
    source: observation.source,
    objectId,
    fact: `${tool.name} returned sandbox data from ${observation.source}.`,
    supports: `${tool.name}:${objectId}`,
    confidence: "medium",
    createdAt: new Date().toISOString(),
  });

  state.evidence.push(evidence);
}
