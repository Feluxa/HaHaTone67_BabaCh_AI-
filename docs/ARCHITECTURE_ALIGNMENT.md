# Architecture Alignment

This project currently combines two layers:

- `app/` is the Next.js UI and thin HTTP layer.
- `src/` is the backend agent core described in `1important_files/ARCHITECTURE (1).md`.

The original architecture describes a standalone Node.js service. For the current repository, the same boundaries are mapped into a Next.js backend-for-frontend shape:

| Architecture document | Repository location | Current status |
| --- | --- | --- |
| Agent Loop | `src/agent/agentLoop.ts` | Scaffolded |
| Orchestrator | `src/agent/orchestrator.ts` | Real sandbox deterministic flow without LLM |
| Agent State | `src/agent/agentState.ts` | Scaffolded |
| LLM Client | `src/llm/gigachatClient.ts` | Stubbed |
| LLM Output Schemas | `src/llm/outputSchemas.ts` | Scaffolded |
| Tool Registry | `src/tools/toolRegistry.ts` | Scaffolded |
| Investigation Tools | `src/tools/investigationTools.ts` | Initial tools |
| Action Tools | `src/tools/actionTools.ts` | Initial refund tool |
| Policy Guard | `src/policy/policyGuard.ts` | Uses real policy engine for refund |
| Policy Engine | `src/policy/policyEngine.ts` | Refund policy against sandbox transaction snapshot |
| Evidence | `src/evidence/*` | Basic model and extractor |
| Sandbox API | `src/sandbox/*` | Fetch-based clients |
| Observability | `src/observability/*` | Console trace scaffold |
| HTTP API | `app/api/health`, `app/api/solve` | Next Route Handlers |

Key decision: the LLM never calls sandbox APIs directly. It proposes a tool call, then backend code validates arguments, checks policy, executes the whitelisted tool, stores observations, and extracts evidence.

## Current Contract

`POST /api/solve`

```json
{
  "caseId": "case_01_subscription_activation",
  "casePassword": "optional",
  "dryRun": true
}
```

`dryRun` defaults to `true` while the GigaChat client and exact sandbox endpoint map are still being implemented.
