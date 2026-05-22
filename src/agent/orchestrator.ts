import { createHash, randomUUID } from "node:crypto";
import { EvidenceSchema } from "../evidence/evidenceTypes";
import { logEvent } from "../observability/logger";
import { checkPolicyGuard } from "../policy/policyGuard";
import { refundTransactionTool } from "../tools/actionTools";
import { RefundTransactionArgsSchema } from "../tools/toolSchemas";
import {
  AgentStateSchema,
  createInitialAgentState,
  type AgentAction,
  type AgentObservation,
} from "./agentState";
import { buildFallbackAnswer } from "./finalizer";

// ─────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────

export interface SolveCaseInput {
  caseId: string;
  casePassword?: string;
  dryRun?: boolean;
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/**
 * Генерирует детерминированный идемпотентный ключ для мутирующих операций.
 * Бэкенд ВСЕГДА генерирует ключ сам — LLM его не видит.
 *
 * @param caseId   - идентификатор кейса
 * @param action   - имя действия (например, "refundTransaction")
 * @param targetId - идентификатор объекта действия
 */
function buildIdempotencyKey(
  caseId: string,
  action: string,
  targetId: string,
): string {
  return createHash("sha256")
    .update(`${caseId}:${action}:${targetId}`)
    .digest("hex")
    .slice(0, 32); // 32 hex-символа = 128 бит
}

/**
 * Маскирует ID клиента для безопасного логирования: видны только последние 3 символа.
 * Используется исключительно для PII-безопасного вывода в лог.
 */
function maskCustomerId(id: string): string {
  return `***${id.slice(-3)}`;
}

// ─────────────────────────────────────────────────────────────
// Mock deterministic flow
// ─────────────────────────────────────────────────────────────

/**
 * solveCase — детерминированный пайплайн расследования без LLM.
 *
 * Симулирует три шага ReAct-цикла:
 *   1. REASON→ACT getTicketMessages  → OBSERVE (сообщения о двойном списании)
 *   2. REASON→ACT getCustomerProfile → OBSERVE (профиль: аккаунт активен)
 *   3. REASON→ACT getTransactions    → OBSERVE (дубликат транзакции через 3 сек)
 *
 * Собирает Evidence, формирует ActionsDone (только при dryRun=false),
 * валидирует итоговый AgentState через Zod перед возвратом.
 *
 * GigaChat НЕ вызывается — подключение LLM будет отдельным этапом.
 */
export async function solveCase(input: SolveCaseInput): Promise<{
  state: ReturnType<typeof AgentStateSchema.parse>;
  metrics: Record<string, unknown>;
  exportData: null;
}> {
  const runId = `run_mock_${randomUUID()}`;
  const isDryRun = input.dryRun ?? true;

  logEvent("info", "agent.run.start", {
    runId,
    caseId: input.caseId,
    dryRun: isDryRun,
    mode: "mock-deterministic",
  });

  // ── Инициализация состояния ───────────────────────────────

  const state = createInitialAgentState({
    runId,
    caseId: input.caseId,
  });

  // Моковые идентификаторы
  const mockTicketId = `TKT-${input.caseId.toUpperCase()}-001`;
  const mockCustomerId = "CUST-88271";
  const txnOriginal = "TXN-441820";
  const txnDuplicate = "TXN-441821";

  // Загрузка фейкового тикета (имитирует casesClient.getCase)
  state.caseData = {
    id: input.caseId,
    intakeTicketId: mockTicketId,
    customerId: mockCustomerId,
    subject: "Двойное списание за покупку в магазине",
    description:
      "Клиент сообщает о двойном списании 3 500 ₽ за покупку в Перекрёстке 22.05.2026.",
    status: "open",
    createdAt: "2026-05-22T14:30:00.000Z",
  };
  state.ticketId = mockTicketId;
  state.customerId = mockCustomerId;
  state.problemSummary = "Клиент жалуется на двойное списание 3 500 ₽";

  logEvent("info", "agent.ticket.loaded", {
    runId,
    ticketId: mockTicketId,
    customerId: maskCustomerId(mockCustomerId),
  });

  // ── Шаг 1: getTicketMessages ──────────────────────────────
  // REASON: нужно прочитать жалобу клиента дословно.
  // ACT:    getTicketMessages(ticketId)
  // OBSERVE: два сообщения; клиент подтверждает двойное списание.

  const obs1: AgentObservation = {
    type: "tool_result",
    source: "getTicketMessages",
    status: "success",
    data: {
      ticketId: mockTicketId,
      messages: [
        {
          id: "msg_001",
          author: "customer",
          text: "Здравствуйте! С моей карты два раза списали по 3 500 ₽ за одну покупку 22 мая. Прошу вернуть деньги.",
          createdAt: "2026-05-22T15:00:00.000Z",
        },
        {
          id: "msg_002",
          author: "bot",
          text: "Ваше обращение принято. Мы изучим ситуацию.",
          createdAt: "2026-05-22T15:01:00.000Z",
        },
      ],
    },
    message: "Загружены 2 сообщения по тикету; клиент явно указывает на двойное списание",
  };

  state.observations.push(obs1);
  state.toolHistory.push("getTicketMessages");

  logEvent("info", "agent.step.tool_executed", {
    runId,
    step: 1,
    tool: "getTicketMessages",
    status: "success",
  });

  // ── Шаг 2: getCustomerProfile ─────────────────────────────
  // REASON: проверить статус аккаунта перед действиями.
  // ACT:    getCustomerProfile(customerId)
  // OBSERVE: аккаунт активен, tier=standard; нет блокировок.

  const obs2: AgentObservation = {
    type: "tool_result",
    source: "getCustomerProfile",
    status: "success",
    data: {
      customerId: maskCustomerId(mockCustomerId), // PII-masked в payload
      tier: "standard",
      accountStatus: "active",
      registeredAt: "2021-03-15T00:00:00.000Z",
    },
    message: "Профиль получен: аккаунт активен, ограничений нет",
  };

  state.observations.push(obs2);
  state.toolHistory.push("getCustomerProfile");

  logEvent("info", "agent.step.tool_executed", {
    runId,
    step: 2,
    tool: "getCustomerProfile",
    status: "success",
  });

  // ── Шаг 3: getTransactions ────────────────────────────────
  // REASON: найти транзакции на дату обращения и проверить дубликат.
  // ACT:    getTransactions(customerId, limit=10)
  // OBSERVE: TXN-441821 создан через 3 сек после TXN-441820 — дубликат.

  const obs3: AgentObservation = {
    type: "tool_result",
    source: "getTransactions",
    status: "success",
    data: {
      customerId: maskCustomerId(mockCustomerId),
      transactions: [
        {
          id: txnOriginal,
          merchant: "Перекрёсток",
          amount: 3500,
          currency: "RUB",
          status: "completed",
          createdAt: "2026-05-22T12:44:00.000Z",
        },
        {
          id: txnDuplicate,
          merchant: "Перекрёсток",
          amount: 3500,
          currency: "RUB",
          status: "completed",
          createdAt: "2026-05-22T12:44:03.000Z", // 3 секунды разницы
        },
        {
          id: "TXN-441000",
          merchant: "Яндекс.Такси",
          amount: 450,
          currency: "RUB",
          status: "completed",
          createdAt: "2026-05-21T19:20:00.000Z",
        },
      ],
    },
    message:
      `Две транзакции на 3 500 RUB в Перекрёстке с разницей 3 сек — ` +
      `классический паттерн дублирования платежа. Дубликат: ${txnDuplicate}`,
  };

  state.observations.push(obs3);
  state.toolHistory.push("getTransactions");

  logEvent("info", "agent.step.tool_executed", {
    runId,
    step: 3,
    tool: "getTransactions",
    status: "success",
    duplicateFound: true,
    duplicateTxnId: txnDuplicate,
  });

  // ── Сбор доказательств (Evidence-First) ───────────────────

  const now = new Date().toISOString();

  const ev1Result = EvidenceSchema.safeParse({
    id: "ev_1",
    source: "getTicketMessages",
    objectId: mockTicketId,
    // Явно упоминаем ID обеих транзакций, чтобы relevantEvidence-фильтр
    // в canRefundTransaction считал этот evidence относящимся к TXN-441821.
    fact: `Клиент письменно подтвердил двойное списание 3 500 ₽ (${txnOriginal} и ${txnDuplicate}) за покупку 22.05.2026 в Перекрёстке.`,
    supports: `Обосновывает необходимость возврата ${txnDuplicate} как дублирующей транзакции`,
    confidence: "high",
    createdAt: now,
  });

  if (!ev1Result.success) {
    logEvent("error", "agent.evidence.invalid", {
      runId,
      evidenceId: "ev_1",
      errors: ev1Result.error.issues,
    });
    throw new Error(`Evidence ev_1 validation failed: ${ev1Result.error.message}`);
  }
  state.evidence.push(ev1Result.data);

  const ev2Result = EvidenceSchema.safeParse({
    id: "ev_2",
    source: "getTransactions",
    objectId: txnDuplicate,
    fact:
      `Транзакция ${txnDuplicate} на 3 500 RUB (Перекрёсток) создана через 3 секунды ` +
      `после ${txnOriginal} той же суммы — паттерн дублирования подтверждён.`,
    supports: "Идентифицирует конкретную транзакцию для возврата",
    confidence: "high",
    createdAt: now,
  });

  if (!ev2Result.success) {
    logEvent("error", "agent.evidence.invalid", {
      runId,
      evidenceId: "ev_2",
      errors: ev2Result.error.issues,
    });
    throw new Error(`Evidence ev_2 validation failed: ${ev2Result.error.message}`);
  }
  state.evidence.push(ev2Result.data);

  logEvent("info", "agent.evidence.collected", {
    runId,
    evidenceCount: state.evidence.length,
    evidenceIds: state.evidence.map((e) => e.id),
  });

  // ── Policy Guard + планирование / исполнение действия ────
  // Все High-risk действия проходят через checkPolicyGuard до помещения
  // в actionsPlanned или actionsDone.

  const idempotencyKey = buildIdempotencyKey(
    input.caseId,
    "refundTransaction",
    txnDuplicate,
  );

  // Формируем аргументы возврата и валидируем через Zod — строго по архитектуре.
  const refundArgs = RefundTransactionArgsSchema.parse({
    transactionId: txnDuplicate,
    customerId: mockCustomerId,
    amount: 3500,
    currency: "RUB",
    reason:
      `Дублирующая транзакция: ${txnDuplicate} создана через 3 секунды после ` +
      `${txnOriginal} с той же суммой и мерчантом. Возврат подтверждён доказательствами.`,
    idempotencyKey,
  });

  // Cast необходим: PolicyGuardInput.tool типизирован как ToolDefinition<unknown>
  // (contravariant по args), а refundTransactionTool — ToolDefinition<RefundTransactionArgs>.
  // Внутри checkPolicyGuard args парсится через RefundTransactionArgsSchema.parse(),
  // поэтому runtime-безопасность гарантирована Zod.
  const guardResult = await checkPolicyGuard({
    tool: refundTransactionTool as import("../tools/toolSchemas").ToolDefinition<unknown>,
    args: refundArgs,
    state,
  });

  if (guardResult.allowed) {
    const policyObs: AgentObservation = {
      type: "policy_allowed",
      source: "policyGuard",
      status: "success",
      data: { tool: "refundTransaction", targetId: txnDuplicate },
      message: guardResult.reason,
    };
    state.observations.push(policyObs);

    const plannedAction: AgentAction = {
      name: "refundTransaction",
      targetId: txnDuplicate,
      status: "planned",
      reason: refundArgs.reason,
      idempotencyKey,
    };
    state.actionsPlanned.push(plannedAction);

    if (!isDryRun) {
      // В боевом режиме здесь был бы вызов refundTransactionTool.execute().
      // Mock-этап: фиксируем исполнение детерминированно.
      const executedAction: AgentAction = { ...plannedAction, status: "success" };
      state.actionsDone.push(executedAction);
      logEvent("info", "agent.action.executed", {
        runId,
        action: "refundTransaction",
        targetId: txnDuplicate,
        idempotencyKey,
      });
    } else {
      logEvent("info", "agent.action.dry_run_skipped", {
        runId,
        action: "refundTransaction",
        targetId: txnDuplicate,
      });
    }
  } else {
    // Политика заблокировала действие — записываем в blockedActions и observations.
    state.blockedActions.push({
      toolName: "refundTransaction",
      targetId: txnDuplicate,
      guardResult,
    });

    const blockedObs: AgentObservation = {
      type: "policy_blocked",
      source: "policyGuard",
      status: "blocked",
      data: { tool: "refundTransaction", targetId: txnDuplicate, code: guardResult.code },
      message: guardResult.reason,
    };
    state.observations.push(blockedObs);

    logEvent("warn", "agent.action.blocked", {
      runId,
      action: "refundTransaction",
      targetId: txnDuplicate,
      code: guardResult.code,
      reason: guardResult.reason,
    });
  }

  // ── Финальный ответ ───────────────────────────────────────

  state.currentHypothesis = "Двойное списание подтверждено — требуется возврат дубликата";

  if (!guardResult.allowed) {
    state.answer =
      `Расследование завершено, однако возврат заблокирован политикой: ${guardResult.reason}`;
  } else if (isDryRun) {
    state.answer =
      `[DRY-RUN] Анализ завершён. Дубликат ${txnDuplicate} (3 500 ₽) выявлен и одобрен ` +
      `Policy Guard. Собрано ${state.evidence.length} ед. доказательств. ` +
      `Для реального возврата передайте dryRun=false.`;
  } else {
    state.answer =
      `Возврат по дублирующей транзакции ${txnDuplicate} (3 500 ₽) успешно инициирован.`;
  }

  state.isFinished = true;

  // ── Страховочная сетка: если по какой-то причине isFinished
  // всё ещё false (например, при будущем рефакторинге потока) —
  // выставляем человекочитаемый fallback перед Zod-валидацией.
  if (!state.isFinished) {
    state.answer = buildFallbackAnswer(state);
    state.isFinished = true;
    logEvent("warn", "agent.run.fallback_answer", {
      runId,
      reason: "isFinished was false before Zod validation",
      evidenceCount: state.evidence.length,
      hasHypothesis: typeof state.currentHypothesis === "string",
    });
  }

  // ── Финальная валидация AgentState через Zod ──────────────

  const stateResult = AgentStateSchema.safeParse(state);
  if (!stateResult.success) {
    logEvent("error", "agent.state.invalid", {
      runId,
      errors: stateResult.error.issues,
    });
    throw new Error(`AgentState validation failed: ${stateResult.error.message}`);
  }

  logEvent("info", "agent.run.complete", {
    runId,
    caseId: input.caseId,
    steps: state.observations.length,
    evidenceCount: state.evidence.length,
    actionsDone: state.actionsDone.length,
    dryRun: isDryRun,
  });

  return {
    state: stateResult.data,
    metrics: {
      runId,
      steps: state.observations.length,
      evidenceCollected: state.evidence.length,
      actionsPlanned: state.actionsPlanned.length,
      actionsDone: state.actionsDone.length,
      dryRun: isDryRun,
      mode: "mock-deterministic",
    },
    exportData: null,
  };
}
