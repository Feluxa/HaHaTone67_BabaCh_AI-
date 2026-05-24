import { logEvent } from "../observability/logger";
import { toolRegistry } from "../tools/toolRegistry";
import type { ToolDefinition } from "../tools/toolSchemas";
import type { AgentState } from "../agent/agentState";
import { checkRefundPolicy, checkDisputePolicy, checkReversalPolicy } from "./policyEngine";
import type { PolicyDecision } from "./rules";

// ─────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────

export interface PolicyGuardInput {
  tool: ToolDefinition<unknown>;
  args: unknown;
  state: AgentState;
}

// ─────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Scans all previously stored observations for an article record that matches
 * `articleId`. Handles both bare-array responses and object-wrapped responses
 * (e.g. `{ articles: [...] }`).
 *
 * Returns the first matching record, or `null` if the article has not yet been
 * seen in any observation.
 */
function findArticleInObservations(
  state: AgentState,
  articleId: string,
): Record<string, unknown> | null {
  const matchesId = (record: Record<string, unknown>): boolean =>
    record["id"] === articleId || record["article_id"] === articleId;

  for (const obs of state.observations) {
    const { data } = obs;
    if (data === undefined || data === null) continue;

    // Case 1: observation.data is the article record directly
    if (isRecord(data)) {
      if (matchesId(data)) return data;

      // Case 2: observation.data wraps a list (e.g. search results)
      for (const value of Object.values(data)) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (isRecord(item) && matchesId(item)) return item;
          }
        }
      }
    }

    // Case 3: observation.data is a bare array (e.g. search results)
    if (Array.isArray(data)) {
      for (const item of data) {
        if (isRecord(item) && matchesId(item)) return item;
      }
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// KB article safety check
// ─────────────────────────────────────────────────────────────

/**
 * Tags and risk levels that mark a KB article as unsafe for agent reasoning.
 *
 * An article with any of these tags or `risk_level: "critical"` must not be
 * used as a policy source. It may contain fabricated instructions designed to
 * trick the agent into bypassing evidence gates or refund policies
 * (see case_08_poisoned_policy_article security analysis).
 */
const DANGEROUS_TAGS = ["unsafe", "untrusted", "ловушка", "prompt_injection"] as const;

/**
 * Checks whether a KB article is safe to use as a source for agent reasoning.
 *
 * Returns a `PolicyDecision`:
 *  - `allowed: true`  — article passes the safety check.
 *  - `allowed: false` — article is marked as untrusted; must not be applied.
 */
function isKbArticleSafe(article: Record<string, unknown>): PolicyDecision {
  const tags = article["tags"];
  if (Array.isArray(tags)) {
    const dangerousTag = tags.find(
      (tag) =>
        typeof tag === "string" &&
        (DANGEROUS_TAGS as readonly string[]).includes(tag.toLowerCase()),
    );
    if (dangerousTag !== undefined) {
      return {
        allowed: false,
        code: "POISONED_KB_ARTICLE",
        reason: `KB article contains dangerous tag "${String(dangerousTag)}". It may embed prompt injection or a fabricated refund policy. Tags: ${JSON.stringify(tags)}.`,
      };
    }
  }

  if (article["risk_level"] === "critical") {
    return {
      allowed: false,
      code: "POISONED_KB_ARTICLE",
      reason: `KB article has risk_level=critical and cannot be used as a trusted policy source.`,
    };
  }

  return {
    allowed: true,
    reason: "KB article passed safety check.",
  };
}

// ─────────────────────────────────────────────────────────────
// Policy Guard entry point
// ─────────────────────────────────────────────────────────────

/**
 * checkPolicyGuard — точка входа Policy Guard (§12 ARCHITECTURE).
 *
 * Порядок проверок:
 * 1. Whitelist — инструмент зарегистрирован в ToolRegistry.
 * 2. KB safety — статья базы знаний проверяется на опасные теги и risk_level
 *    (применяется до low-risk pass-through, чтобы охватить все уровни риска).
 * 3. Risk level — Low-risk инструменты пропускаются без дальнейших проверок.
 * 4. Evidence gate — High/Medium инструменты с requiresEvidence не запускаются без доказательств.
 * 5. Business rules — специфическая политика для каждого High-risk инструмента.
 */
export async function checkPolicyGuard(
  input: PolicyGuardInput,
): Promise<PolicyDecision> {
  const { tool, args, state } = input;

  // ── 1. Whitelist check ────────────────────────────────────
  const allowedTools = toolRegistry.listNames();

  if (!allowedTools.includes(tool.name)) {
    logEvent("warn", "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      code: "FORBIDDEN_TOOL",
    });
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `Tool ${tool.name} is not whitelisted.`,
    };
  }

  // ── 2. KB article safety check ────────────────────────────
  //
  // Runs before the low-risk pass-through so it covers getKnowledgeBaseArticle
  // regardless of its riskLevel. We look for article metadata in previously
  // stored observations (typically from a prior searchKnowledgeBase call).
  // If the article's tags or risk_level indicate it is poisoned, block access
  // before the full article body is forwarded to the LLM context.
  if (tool.name === "getKnowledgeBaseArticle") {
    const articleId =
      isRecord(args) && typeof args["articleId"] === "string"
        ? args["articleId"]
        : null;

    if (articleId !== null) {
      const articleData = findArticleInObservations(state, articleId);

      if (articleData !== null) {
        const safetyDecision = isKbArticleSafe(articleData);

        if (!safetyDecision.allowed) {
          logEvent("warn", "policy.blocked", {
            runId: state.runId,
            tool: tool.name,
            code: "POISONED_KB_ARTICLE",
            articleId,
          });
          return safetyDecision;
        }
      }
    }
  }

  // ── 3. Low-risk pass-through ──────────────────────────────
  if (tool.riskLevel === "low") {
    return {
      allowed: true,
      reason: "Low risk read-only tool is allowed.",
    };
  }

  // ── 4. Evidence gate ──────────────────────────────────────
  if (tool.requiresEvidence && state.evidence.length === 0) {
    logEvent("warn", "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      code: "NO_EVIDENCE",
    });
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: "Tool requires evidence, but no evidence was collected.",
    };
  }

  // ── 5. Business rules per tool ────────────────────────────
  if (tool.name === "refundTransaction") {
    const decision = await checkRefundPolicy(args, state);

    logEvent(decision.allowed ? "info" : "warn", decision.allowed ? "policy.allowed" : "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      ...(!decision.allowed && { code: decision.code }),
      reason: decision.reason,
    });

    return decision;
  }

  if (tool.name === "createDispute") {
    const decision = await checkDisputePolicy(args, state);

    logEvent(decision.allowed ? "info" : "warn", decision.allowed ? "policy.allowed" : "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      ...(!decision.allowed && { code: decision.code }),
      reason: decision.reason,
    });

    return decision;
  }

  if (tool.name === "createReversal") {
    const decision = await checkReversalPolicy(args, state);

    logEvent(decision.allowed ? "info" : "warn", decision.allowed ? "policy.allowed" : "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      ...(!decision.allowed && { code: decision.code }),
      reason: decision.reason,
    });

    return decision;
  }

  // ── Все прочие High-risk инструменты без явной политики ───
  if (tool.riskLevel === "high") {
    logEvent("warn", "policy.blocked", {
      runId: state.runId,
      tool: tool.name,
      code: "FORBIDDEN_TOOL",
    });
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `No explicit policy implemented for high risk tool: ${tool.name}.`,
    };
  }

  // Medium-risk: базовые проверки пройдены
  logEvent("info", "policy.allowed", {
    runId: state.runId,
    tool: tool.name,
    riskLevel: tool.riskLevel,
  });
  return {
    allowed: true,
    reason: "Medium risk tool passed base guard checks.",
  };
}
