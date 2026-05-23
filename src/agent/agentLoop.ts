import { getNextDecision } from "../llm/gigachatClient";
import { logEvent } from "../observability/logger";
import { checkPolicyGuard } from "../policy/policyGuard";
import { toolRegistry } from "../tools/toolRegistry";
import type { AgentState } from "./agentState";
import { buildFallbackAnswer } from "./finalizer";

/**
 * runAgentLoop — основной ReAct-цикл агента (§6 ARCHITECTURE).
 *
 * Каждую итерацию цикл выполняет три шага:
 *   Reason  — запрашивает решение у LLM через {@link getNextDecision}.
 *   Act     — валидирует решение и, при наличии разрешения Policy Guard,
 *             вызывает инструмент через его `execute`.
 *   Observe — сохраняет результат в `state.observations`.
 *
 * Функция мутирует `state` напрямую; вызывающий код получает итоговое
 * состояние через тот же указатель — возврат значения не требуется.
 *
 * @param state — текущее состояние агента; должно быть создано фабрикой
 *                {@link createInitialAgentState} до передачи в цикл.
 */
export async function runAgentLoop(state: AgentState): Promise<void> {
  for (let step = 0; step < state.maxSteps; step += 1) {
    // ── Reason: запросить следующее решение от LLM ────────────────────────
    const decision = await getNextDecision(state);

    // §19 ARCHITECTURE: каждое решение LLM должно попадать в трейс.
    // toolName и riskLevel присутствуют только в ветке "tool_call".
    logEvent("info", "llm.decision", {
      runId: state.runId,
      step,
      nextStep: decision.nextStep,
      toolName: decision.nextStep === "tool_call" ? decision.toolName : undefined,
      riskLevel: decision.nextStep === "tool_call" ? decision.riskLevel : undefined,
    });

    // ── Terminal branch: агент сформировал финальный ответ ────────────────
    if (decision.nextStep === "final_answer") {
      state.answer = decision.answer;
      state.isFinished = true;
      break;
    }

    // ── Ожидание данных: продолжаем расследование, не завершаем цикл ──────
    //
    // В отличие от "final_answer", здесь нет `break`: LLM сигнализирует, что
    // ей нужно больше информации, и агент должен попробовать ещё раз.
    if (decision.nextStep === "need_more_info") {
      state.observations.push({
        type: "need_more_info",
        source: "llm",
        status: "failed",
        data: { missingInfo: decision.missingInfo },
        message: decision.reason,
      });
      continue;
    }

    // ── Tool call: Reason → Act → Observe ─────────────────────────────────
    //
    // На данном этапе TypeScript сузил тип decision до дискриминированной
    // ветки "tool_call" — поля toolName и toolArgs гарантированно доступны.

    const { toolName, toolArgs, riskLevel } = decision;

    // ── Act §1: Whitelist — инструмент обязан быть зарегистрирован ────────
    const tool = toolRegistry.get(toolName);
    if (!tool) {
      state.observations.push({
        type: "tool_error",
        source: "toolRegistry",
        status: "failed",
        data: { toolName },
        message: `Tool "${toolName}" is not registered in the tool registry.`,
      });
      logEvent("warn", "tool.not_found", {
        runId: state.runId,
        step,
        toolName,
      });
      continue;
    }

    // ── Act §2: Schema validation — args должны соответствовать inputSchema ─
    //
    // Используем safeParse (не parse), чтобы получить Result вместо
    // исключения — согласно архитектурному принципу функционального
    // error handling (CLAUDE.md §1).
    const parseResult = tool.inputSchema.safeParse(toolArgs);
    if (!parseResult.success) {
      state.observations.push({
        type: "tool_error",
        source: toolName,
        status: "failed",
        data: { validationErrors: parseResult.error.format() },
        message: `Invalid arguments for tool "${toolName}": ${JSON.stringify(parseResult.error.format())}`,
      });
      logEvent("warn", "tool.invalid_args", {
        runId: state.runId,
        step,
        toolName,
        errors: parseResult.error.format(),
      });
      continue;
    }

    const validatedArgs = parseResult.data;

    // ── Act §3: Policy Guard — бизнес-правила, evidence gate, whitelist ───
    //
    // checkPolicyGuard возвращает discriminated union PolicyDecision;
    // никакие исключения не выбрасываются на этом уровне.
    const policyDecision = await checkPolicyGuard({ tool, args: validatedArgs, state });

    if (!policyDecision.allowed) {
      state.observations.push({
        type: "policy_blocked",
        source: "policyGuard",
        status: "blocked",
        data: {
          toolName,
          code: policyDecision.code,
          riskLevel,
        },
        message: policyDecision.reason,
      });
      // blockedActions позволяет orchestrator'у и трейсу восстановить,
      // какие действия были отклонены и по какой причине.
      state.blockedActions.push({
        toolName,
        code: policyDecision.code,
        reason: policyDecision.reason,
        step,
      });
      continue;
    }

    // ── Act §4: Execute — инструмент вызывает реальный sandbox-эндпоинт ───
    //
    // Прямые HTTP-вызовы к sandbox запрещены здесь; только через tool.execute.
    logEvent("info", "tool.called", {
      runId: state.runId,
      step,
      toolName,
      riskLevel: tool.riskLevel,
    });

    const observation = await tool.execute(validatedArgs, state);

    // ── Observe: сохранить результат в истории ────────────────────────────
    state.toolHistory.push(toolName);
    state.observations.push(observation);

    logEvent("info", "tool.observed", {
      runId: state.runId,
      step,
      toolName,
      status: observation.status,
    });
  }

  // ── После цикла: страховочная сетка (finalizer) ───────────────────────
  //
  // Если maxSteps исчерпан или ни один шаг не привёл к final_answer,
  // buildFallbackAnswer формирует человекочитаемый ответ из накопленных
  // evidence и currentHypothesis (см. §12.1 ARCHITECTURE, finalizer.ts).
  if (!state.isFinished) {
    state.answer = buildFallbackAnswer(state);
  }
}
