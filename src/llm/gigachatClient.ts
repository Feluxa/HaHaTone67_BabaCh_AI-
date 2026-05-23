import { randomUUID } from "node:crypto";
import https from "node:https";
import type { AgentState } from "../agent/agentState";
import { getEnv } from "../config/env";
import { toolRegistry } from "../tools/toolRegistry";
import { buildSystemPrompt } from "./systemPrompt";
import {
  LlmDecisionSchema,
  parseLlmDecision,
  type LlmDecision,
} from "./outputSchemas";

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

interface HttpResponse<TBody> {
  statusCode: number;
  body: TBody;
  rawBody: string;
}

interface GigaChatTokenResponse {
  access_token?: string;
  expires_at?: number;
  expires_in?: number;
}

interface GigaChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

export interface LlmClient {
  nextDecision(state: AgentState): Promise<LlmDecision>;
}

let cachedToken: CachedToken | null = null;

const insecureHttpsAgent = new https.Agent({
  rejectUnauthorized: false,
});

function requestJson<TBody>(input: {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
}): Promise<HttpResponse<TBody>> {
  return new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const request = https.request(
      url,
      {
        method: input.method,
        headers: input.headers,
        agent: insecureHttpsAgent,
      },
      (response) => {
        const chunks: Buffer[] = [];

        response.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });

        response.on("end", () => {
          const rawBody = Buffer.concat(chunks).toString("utf8");
          const statusCode = response.statusCode ?? 0;

          if (statusCode < 200 || statusCode >= 300) {
            reject(
              new Error(
                `GigaChat ${input.method} ${url.toString()} failed: ${statusCode} ${rawBody}`,
              ),
            );
            return;
          }

          try {
            resolve({
              statusCode,
              body: rawBody.length > 0 ? (JSON.parse(rawBody) as TBody) : ({} as TBody),
              rawBody,
            });
          } catch (error) {
            reject(
              new Error(
                `GigaChat ${input.method} ${url.toString()} returned invalid JSON: ${
                  error instanceof Error ? error.message : "unknown parse error"
                }`,
              ),
            );
          }
        });
      },
    );

    request.on("error", reject);
    request.setTimeout(60_000, () => {
      request.destroy(new Error(`GigaChat ${input.method} ${url.toString()} timed out`));
    });

    if (input.body !== undefined) {
      request.write(input.body);
    }

    request.end();
  });
}

function getTokenExpiry(body: GigaChatTokenResponse): number {
  const now = Date.now();
  const safetyWindowMs = 60_000;

  if (typeof body.expires_at === "number" && body.expires_at > now) {
    return body.expires_at - safetyWindowMs;
  }

  if (typeof body.expires_in === "number" && body.expires_in > 0) {
    return now + body.expires_in * 1000 - safetyWindowMs;
  }

  return now + 29 * 60 * 1000;
}

async function getAccessToken(): Promise<string> {
  const env = getEnv();

  if (!env.GIGACHAT_API_KEY) {
    throw new Error("GIGACHAT_API_KEY is required to call GigaChat");
  }

  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.accessToken;
  }

  const body = new URLSearchParams({
    scope: env.GIGACHAT_SCOPE,
  }).toString();

  const response = await requestJson<GigaChatTokenResponse>({
    url: env.GIGACHAT_AUTH_URL,
    method: "POST",
    headers: {
      Authorization: `Basic ${env.GIGACHAT_API_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      RqUID: randomUUID(),
    },
    body,
  });

  if (!response.body.access_token) {
    throw new Error(`GigaChat OAuth response does not contain access_token: ${response.rawBody}`);
  }

  cachedToken = {
    accessToken: response.body.access_token,
    expiresAt: getTokenExpiry(response.body),
  };

  return cachedToken.accessToken;
}

function compactState(state: AgentState): unknown {
  return {
    runId: state.runId,
    caseId: state.caseId,
    ticketId: state.ticketId,
    customerId: state.customerId,
    problemSummary: state.problemSummary,
    currentHypothesis: state.currentHypothesis,
    evidence: state.evidence,
    observations: state.observations.slice(-8),
    actionsPlanned: state.actionsPlanned,
    actionsDone: state.actionsDone,
    toolHistory: state.toolHistory,
    blockedActions: state.blockedActions,
    maxSteps: state.maxSteps,
    isFinished: state.isFinished,
    caseData: state.caseData,
  };
}

function toolInputShape(toolName: string): unknown {
  const shapes: Record<string, unknown> = {
    getTicketMessages: {
      ticketId: "string, use state.ticketId or intake.ticket_id",
    },
    getCustomerProfile: {
      customerId: "string, use state.customerId or user_id from ticket data",
    },
    getTransactions: {
      customerId: "string, use state.customerId or user_id from ticket data",
      limit: "number, optional, default 50, max 100",
    },
    getUserProfile: {
      userId: "string, use state.customerId or user_id from ticket data",
    },
    getTransactionById: {
      transactionId: "string, use a txn_* id from observations",
    },
    getSubscriptionById: {
      subscriptionId: "string, use a sub_* id from observations",
    },
    searchKnowledgeBase: {
      query: "string",
    },
    refundTransaction: {
      transactionId: "string, txn_* id",
      customerId: "string, usr_* id",
      amount: "number",
      currency: "3-letter currency code",
      reason: "string, 10..500 chars",
      idempotencyKey: "string, at least 16 chars",
    },
  };

  return shapes[toolName] ?? "See tool description.";
}

function toolContext(): unknown {
  return toolRegistry.list().map((tool) => ({
    name: tool.name,
    description: tool.description,
    riskLevel: tool.riskLevel,
    requiresEvidence: tool.requiresEvidence,
    requiresPolicyCheck: tool.requiresPolicyCheck,
    inputShape: toolInputShape(tool.name),
  }));
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed);
  } catch {
    // Continue with tolerant extraction below.
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) {
    return JSON.parse(fenced[1]);
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
  }

  throw new Error("No JSON object found in GigaChat response");
}

function buildUserPrompt(state: AgentState): string {
  return JSON.stringify(
    {
      task: "Return the next agent decision as exactly one JSON object matching LlmDecisionSchema.",
      decisionPolicy: [
        "Use state.ticketId first to load the support ticket.",
        "After ticket data is loaded, use its user_id as customerId/userId.",
        "Before final_answer, collect concrete object evidence: ticket, user/subscription/transaction as relevant.",
        "Before final_answer, call searchKnowledgeBase with a concise query for the detected scenario.",
        "Do not repeat a tool call if the same tool with the same identifier already succeeded.",
      ],
      availableTools: toolContext(),
      state: compactState(state),
      schemaSummary: {
        tool_call: {
          nextStep: "tool_call",
          thoughtSummary: "string 10..1000",
          toolName: "one of availableTools.name",
          toolArgs: "object matching selected tool",
          reason: "string 10..1000",
          riskLevel: "low | medium | high",
        },
        final_answer: {
          nextStep: "final_answer",
          thoughtSummary: "string 10..1000",
          answer: "client-facing string 20..3000",
          evidenceIds: "non-empty string[]",
        },
        need_more_info: {
          nextStep: "need_more_info",
          thoughtSummary: "string 10..1000",
          missingInfo: "non-empty string[]",
          reason: "string 10..1000",
        },
      },
    },
    null,
    2,
  );
}

async function callGigaChat(state: AgentState): Promise<string> {
  const env = getEnv();
  const accessToken = await getAccessToken();

  const response = await requestJson<GigaChatCompletionResponse>({
    url: env.GIGACHAT_API_URL,
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      model: env.GIGACHAT_MODEL,
      temperature: 0.1,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(),
        },
        {
          role: "user",
          content: buildUserPrompt(state),
        },
      ],
    }),
  });

  const content = response.body.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(`GigaChat response does not contain choices[0].message.content: ${response.rawBody}`);
  }

  return content;
}

export async function getNextDecision(state: AgentState): Promise<LlmDecision> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const content = await callGigaChat(state);

    try {
      const rawDecision = extractJsonObject(content);
      return parseLlmDecision(rawDecision);
    } catch (error) {
      lastError = error;

      if (attempt === 3) {
        break;
      }
    }
  }

  throw new Error(
    `GigaChat returned invalid LlmDecision JSON after 3 attempts: ${
      lastError instanceof Error ? lastError.message : "unknown validation error"
    }. Expected schema: ${JSON.stringify(LlmDecisionSchema.def)}`,
  );
}

export const gigachatClient: LlmClient = {
  nextDecision: getNextDecision,
};
