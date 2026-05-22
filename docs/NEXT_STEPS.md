# Next Steps

## Phase 1. Make the scaffold executable

1. Confirm the exact sandbox endpoint names from `/meta/endpoints`.
2. Replace placeholder paths in `src/tools/*` and `src/policy/policyEngine.ts` with real sandbox routes.
3. Add focused tests for tool argument validation and policy guard decisions.
4. Add `.env.example` with `SANDBOX_URL`, `TEAM_NAME`, `GIGACHAT_API_KEY`, and `GIGACHAT_MODEL`.

## Phase 2. Connect GigaChat

1. Implement `src/llm/gigachatClient.ts` against the real GigaChat API.
2. Pass `SYSTEM_PROMPT`, current `AgentState`, and whitelisted tool descriptions to the model.
3. Parse and validate every model response through `LlmDecisionSchema`.
4. Add retry and failure handling for invalid JSON or unavailable model responses.

## Phase 3. Build reliable investigation tools

1. Implement ticket, customer, account, card, transaction, ledger, KYC, fraud, merchant, and knowledge-base read tools.
2. Normalize observations so evidence extraction does not depend on raw endpoint shapes.
3. Keep mutating tools separate from read-only tools and require explicit policies for each high-risk action.

## Phase 4. Strengthen policy and evidence

1. Replace the basic evidence extractor with endpoint-specific evidence builders.
2. Require at least two relevant evidence records for high-risk actions.
3. Add idempotency keys for every mutating tool.
4. Persist run state and trace when Postgres/Redis are introduced.

## Phase 5. Improve UI demonstration

1. Wire the dashboard to `/api/health` and `/api/solve`.
2. Show run creation, tool calls, observations, policy decisions, evidence, final answer, metrics, and export.
3. Keep client-facing answers separate from internal trace details.

## Phase 6. Package and deploy

1. Add Dockerfile and docker-compose for Next.js plus bank sandbox.
2. Add CI checks for lint, typecheck, and tests.
3. Verify the full flow against open cases first, then add support for password-protected cases.
