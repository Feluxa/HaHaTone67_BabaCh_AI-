# ARCHITECTURE.md

# Архитектура AI-агента службы поддержки

**Статус:** итоговое техническое руководство  
**Роль документа:** единая архитектурная спецификация для команды разработки  
**Платформа:** Node.js + TypeScript  
**LLM:** GigaChat  
**Целевая среда:** Bank Support Sandbox + локальный запуск  

---

## 1. Назначение системы

AI-агент службы поддержки должен автономно обрабатывать обращения клиентов, расследовать проблему через доступные API, собирать доказательства, проверять внутренние правила компании и выполнять только разрешённые действия.

Ключевой принцип:

> GigaChat не управляет системой напрямую.  
> Модель выбирает следующий шаг и предлагает tool call, но фактический API-вызов выполняет backend после валидации, проверки политики и проверки доказательств.

Агент должен решать задачи в формате:

```text
Ticket → Investigation → Evidence → Policy Check → Action → Verification → Evaluator
```

---

## 2. Целевой пайплайн системы

```text
1. Получение case_id
        ↓
2. POST /runs
        ↓
3. Получение run_id
        ↓
4. GET /cases/{case_id}
        ↓
5. Получение intake ticket
        ↓
6. Agent Loop: Reason → Act → Observe
        ↓
7. Сбор Evidence
        ↓
8. Policy Engine / Policy Guard
        ↓
9. Безопасный вызов API песочницы
        ↓
10. Проверка результата действия
        ↓
11. Формирование клиентского ответа
        ↓
12. POST /cases/{case_id}/evaluate
        ↓
13. GET /runs/{run_id}/metrics
        ↓
14. GET /runs/{run_id}/export
```

---

## 3. Архитектурные принципы

| Принцип | Описание |
|---|---|
| Evidence-first | Агент не делает выводы и не вызывает мутирующие API без доказательств. |
| Policy-before-action | Любое действие с риском проходит через Policy Engine. |
| Backend-controlled execution | LLM не вызывает HTTP API напрямую. Все вызовы выполняет backend. |
| Strict validation | Все ответы LLM и параметры инструментов валидируются через Zod. |
| Whitelisted tools | Агент видит только разрешённые инструменты, а не весь каталог API. |
| Risk-based access | Инструменты разделены по уровню риска: Low, Medium, High. |
| Idempotency | High risk действия должны иметь защиту от повторного выполнения. |
| Observability | Каждый шаг агента логируется: decision, tool call, observation, evidence, action. |

---

## 4. Технологический стек

| Слой | Технология | Назначение |
|---|---|---|
| Runtime | Node.js 20+ | Исполнение backend-сервиса агента |
| Язык | TypeScript | Строгая типизация бизнес-логики и API-контрактов |
| HTTP Framework | Fastify или Express | REST API агента |
| Validation | Zod | Валидация LLM JSON-output, tool args, sandbox responses |
| HTTP Client | Axios / Undici | Запросы к Bank Support Sandbox |
| LLM | GigaChat API | Reasoning, tool selection, финальный ответ |
| Storage | PostgreSQL | Трейсы, evidence, actions, результаты runs |
| Cache/State | Redis | Временное состояние Agent Loop |
| Infra | Docker, Docker Compose | Локальный запуск Sandbox и приложения |
| Observability | Pino, OpenTelemetry | Логи и трассировка действий |

---

## 5. Компоненты системы

```text
src/
├── app.ts
├── config/
│   └── env.ts
│
├── llm/
│   ├── gigachatClient.ts
│   ├── systemPrompt.ts
│   └── outputSchemas.ts
│
├── agent/
│   ├── orchestrator.ts
│   ├── agentState.ts
│   ├── agentLoop.ts
│   └── finalizer.ts
│
├── tools/
│   ├── toolRegistry.ts
│   ├── investigationTools.ts
│   ├── actionTools.ts
│   └── toolSchemas.ts
│
├── policy/
│   ├── policyEngine.ts
│   ├── policyGuard.ts
│   └── rules.ts
│
├── sandbox/
│   ├── sandboxClient.ts
│   ├── runsClient.ts
│   ├── casesClient.ts
│   └── evaluatorClient.ts
│
├── evidence/
│   ├── evidenceCollector.ts
│   └── evidenceTypes.ts
│
├── observability/
│   ├── logger.ts
│   └── trace.ts
│
└── routes/
    ├── health.ts
    └── solve.ts
```

---

## 6. Agent Loop: Reason → Act → Observe

Агент работает как машина состояний. На каждом шаге он получает текущее состояние расследования и возвращает одно из решений:

1. вызвать инструмент;
2. продолжить расследование;
3. завершить кейс;
4. отказаться от действия, если данных недостаточно.

### 6.1. Типовой цикл

```text
Reason:
  Агент анализирует тикет, историю действий и собранные факты.

Act:
  Агент предлагает tool call:
  - toolName
  - args
  - reason
  - expectedEvidence

Observe:
  Backend выполняет проверку, вызывает инструмент и сохраняет результат.
```

### 6.2. TypeScript-псевдокод Agent Loop

```ts
export async function solveCase(caseId: string): Promise<AgentResult> {
  const run = await runsClient.createRun();
  const state = await createInitialAgentState({
    runId: run.id,
    caseId,
  });

  const caseData = await casesClient.getCase(caseId, run.id);
  state.caseData = caseData;
  state.ticketId = caseData.intakeTicketId;

  for (let step = 0; step < state.maxSteps; step++) {
    const llmRawOutput = await gigachatClient.nextDecision(state);

    const decision = parseLlmDecision(llmRawOutput);

    traceDecision(state, decision);

    if (decision.nextStep === "tool_call") {
      const tool = toolRegistry.get(decision.toolName);

      if (!tool) {
        state.observations.push({
          type: "tool_error",
          message: `Unknown tool: ${decision.toolName}`,
        });
        continue;
      }

      const validatedArgs = tool.inputSchema.parse(decision.toolArgs);

      const guardResult = await policyGuard.check({
        tool,
        args: validatedArgs,
        state,
      });

      if (!guardResult.allowed) {
        state.observations.push({
          type: "blocked_action",
          reason: guardResult.reason,
        });
        continue;
      }

      const observation = await tool.execute(validatedArgs, state);

      state.observations.push(observation);

      evidenceCollector.extractFromObservation({
        state,
        tool,
        args: validatedArgs,
        observation,
      });

      continue;
    }

    if (decision.nextStep === "final_answer") {
      state.answer = decision.answer;
      state.isFinished = true;
      break;
    }
  }

  if (!state.isFinished) {
    state.answer = finalizer.buildFallbackAnswer(state);
  }

  const evaluation = await evaluatorClient.evaluateCase({
    caseId,
    runId: state.runId,
    answer: state.answer,
    evidence: state.evidence,
    actions: state.actionsDone,
  });

  const metrics = await runsClient.getMetrics(state.runId);
  const exportData = await runsClient.getExport(state.runId);

  return {
    state,
    evaluation,
    metrics,
    exportData,
  };
}
```

---

## 7. Состояние агента

```ts
export type RiskLevel = "low" | "medium" | "high";

export interface Evidence {
  id: string;
  source: string;
  objectId: string;
  fact: string;
  supports: string;
  confidence: "low" | "medium" | "high";
  createdAt: string;
}

export interface AgentAction {
  name: string;
  targetId: string;
  status: "planned" | "success" | "failed" | "blocked";
  reason: string;
  idempotencyKey?: string;
}

export interface AgentState {
  runId: string;
  caseId: string;
  ticketId?: string;
  customerId?: string;

  problemSummary?: string;
  currentHypothesis?: string;

  evidence: Evidence[];
  observations: unknown[];
  actionsPlanned: AgentAction[];
  actionsDone: AgentAction[];

  toolHistory: unknown[];
  blockedActions: unknown[];

  answer?: string;
  isFinished: boolean;
  maxSteps: number;

  caseData?: unknown;
}
```

---

## 8. Tool Registry

LLM получает описание только тех инструментов, которые backend разрешает использовать.

### 8.1. Уровни риска

| Risk level | Тип действий | Примеры |
|---|---|---|
| Low | Только чтение | `getTicketMessages`, `getCustomerProfile`, `getTransactions` |
| Medium | Коммуникации и служебные изменения | `sendNotification`, `addInternalComment`, `updateTicketStatus` |
| High | Деньги, блокировки, лимиты, подписки | `refundTransaction`, `cancelSubscription`, `unlockCard`, `releaseHold` |

### 8.2. Контракт инструмента

```ts
import { z } from "zod";

export interface ToolDefinition<TArgs> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresEvidence: boolean;
  requiresPolicyCheck: boolean;
  inputSchema: z.ZodType<TArgs>;
  execute: (args: TArgs, state: AgentState) => Promise<unknown>;
}
```

---

## 9. Валидация JSON-output от GigaChat через Zod

LLM output считается недоверенным вводом. Его нельзя передавать в систему без проверки.

### 9.1. Схема решения агента

```ts
import { z } from "zod";

export const LlmDecisionSchema = z.discriminatedUnion("nextStep", [
  z.object({
    nextStep: z.literal("tool_call"),
    thoughtSummary: z.string().min(10).max(1000),
    toolName: z.string().min(1),
    toolArgs: z.record(z.string(), z.unknown()),
    reason: z.string().min(10).max(1000),
    riskLevel: z.enum(["low", "medium", "high"]),
  }),

  z.object({
    nextStep: z.literal("final_answer"),
    thoughtSummary: z.string().min(10).max(1000),
    answer: z.string().min(20).max(3000),
    evidenceIds: z.array(z.string()).min(1),
  }),

  z.object({
    nextStep: z.literal("need_more_info"),
    thoughtSummary: z.string().min(10).max(1000),
    missingInfo: z.array(z.string()).min(1),
    reason: z.string().min(10).max(1000),
  }),
]);

export type LlmDecision = z.infer<typeof LlmDecisionSchema>;
```

> **Примечание (Zod v4):** В проекте используется Zod **v4.4.3**, в котором `z.record()` требует явный тип ключа. `z.record(z.string(), z.unknown())` — это эквивалент `z.record(z.unknown())` из Zod v3; результирующий TypeScript-тип `Record<string, unknown>` идентичен.

### 9.2. Безопасный парсинг ответа LLM

```ts
export function parseLlmDecision(raw: unknown): LlmDecision {
  const result = LlmDecisionSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(
      `Invalid LLM decision schema: ${JSON.stringify(result.error.format())}`,
    );
  }

  return result.data;
}
```

### 9.3. Валидация аргументов конкретного инструмента

```ts
import { z } from "zod";

export const RefundTransactionArgsSchema = z.object({
  transactionId: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
  reason: z
    .string()
    .min(10)
    .max(500),
  idempotencyKey: z.string().min(16),
});

export type RefundTransactionArgs = z.infer<
  typeof RefundTransactionArgsSchema
>;
```

> **Примечание:** Схема определена в `src/llm/outputSchemas.ts` как единственный источник истины — она валидирует аргументы, которые предлагает LLM. В `src/tools/toolSchemas.ts` находится реэкспорт (`export { RefundTransactionArgsSchema, type RefundTransactionArgs } from "../llm/outputSchemas"`) для обратной совместимости всех существующих импортов.

### 9.4. Пример Tool Definition

```ts
export const refundTransactionTool: ToolDefinition<RefundTransactionArgs> = {
  name: "refundTransaction",
  description:
    "Возвращает деньги по конкретной транзакции, если это разрешено политикой.",
  riskLevel: "high",
  requiresEvidence: true,
  requiresPolicyCheck: true,
  inputSchema: RefundTransactionArgsSchema,

  async execute(args, state) {
    return sandboxClient.post(
      `/actions/refund`,
      {
        transaction_id: args.transactionId,
        customer_id: args.customerId,
        amount: args.amount,
        currency: args.currency,
        reason: args.reason,
        idempotency_key: args.idempotencyKey,
      },
      {
        headers: {
          "X-Run-Id": state.runId,
        },
      },
    );
  },
};
```

---

## 10. Policy Engine и Policy Guard

Policy Engine отвечает за бизнес-правила.  
Policy Guard отвечает за применение этих правил перед вызовом инструмента.

### 10.1. Обязательные проверки для High Risk

| Проверка | Цель |
|---|---|
| Evidence exists | Есть факты, подтверждающие необходимость действия |
| Evidence relevance | Evidence относится к нужному клиенту и объекту |
| Policy limits | Сумма и тип операции не нарушают лимиты |
| Current state | Объект находится в состоянии, допускающем действие |
| No duplicate action | Действие не было выполнено ранее |
| Idempotency key | Повторный вызов не приведёт к повторному списанию/возврату |
| Allowed endpoint | Инструмент входит в whitelist |

---

## 11. Пример Policy Guard для High Risk действия

Ниже пример проверки перед возвратом транзакции.

```ts
type PolicyDecision =
  | {
      allowed: true;
      reason: string;
    }
  | {
      allowed: false;
      reason: string;
      code:
        | "NO_EVIDENCE"
        | "INSUFFICIENT_EVIDENCE"
        | "LIMIT_EXCEEDED"
        | "INVALID_TRANSACTION_STATE"
        | "DUPLICATE_ACTION"
        | "MISSING_IDEMPOTENCY_KEY"
        | "FORBIDDEN_TOOL";
    };

interface RefundPolicyConfig {
  maxAutoRefundAmount: number;
  allowedCurrencies: string[];
}

interface TransactionSnapshot {
  id: string;
  customerId: string;
  amount: number;
  currency: string;
  status: "pending" | "completed" | "failed" | "refunded";
  alreadyRefunded: boolean;
}

interface RefundPolicyInput {
  args: RefundTransactionArgs;
  transaction: TransactionSnapshot;
  evidence: Evidence[];
  previousActions: AgentAction[];
  policy: RefundPolicyConfig;
}

export function canRefundTransaction(input: RefundPolicyInput): PolicyDecision {
  const { args, transaction, evidence, previousActions, policy } = input;

  if (!args.idempotencyKey || args.idempotencyKey.length < 16) {
    return {
      allowed: false,
      code: "MISSING_IDEMPOTENCY_KEY",
      reason: "High risk action requires a valid idempotency key.",
    };
  }

  const relevantEvidence = evidence.filter((item) => {
    return (
      item.objectId === args.transactionId ||
      item.supports.includes(args.transactionId) ||
      item.fact.includes(args.transactionId)
    );
  });

  if (relevantEvidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: "No evidence found for the target transaction.",
    };
  }

  if (relevantEvidence.length < 2) {
    return {
      allowed: false,
      code: "INSUFFICIENT_EVIDENCE",
      reason: "High risk refund requires at least two evidence records.",
    };
  }

  if (transaction.customerId !== args.customerId) {
    return {
      allowed: false,
      code: "INVALID_TRANSACTION_STATE",
      reason: "Transaction does not belong to the target customer.",
    };
  }

  // Порядок намеренный: alreadyRefunded проверяется до TypeScript-сужения типа status.
  // Если поставить проверку status !== "completed" первой, компилятор сузит тип status
  // до "completed" в следующей ветке, и status === "refunded" станет недостижимым.
  if (transaction.alreadyRefunded || transaction.status === "refunded") {
    return {
      allowed: false,
      code: "DUPLICATE_ACTION",
      reason: "Transaction has already been refunded.",
    };
  }

  if (transaction.status !== "completed") {
    return {
      allowed: false,
      code: "INVALID_TRANSACTION_STATE",
      reason: "Only completed transactions can be refunded.",
    };
  }

  const duplicateAction = previousActions.some((action) => {
    return (
      action.name === "refundTransaction" &&
      action.targetId === args.transactionId &&
      action.status === "success"
    );
  });

  if (duplicateAction) {
    return {
      allowed: false,
      code: "DUPLICATE_ACTION",
      reason: "Refund action was already executed for this transaction.",
    };
  }

  if (args.amount > policy.maxAutoRefundAmount) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      reason: `Refund amount exceeds max auto refund limit: ${policy.maxAutoRefundAmount}.`,
    };
  }

  if (!policy.allowedCurrencies.includes(args.currency)) {
    return {
      allowed: false,
      code: "LIMIT_EXCEEDED",
      reason: `Currency ${args.currency} is not allowed for automatic refund.`,
    };
  }

  return {
    allowed: true,
    reason: "Refund is allowed by policy and supported by evidence.",
  };
}
```

---

## 12. Интеграция Policy Guard в Tool Execution

```ts
interface PolicyGuardInput<TArgs> {
  tool: ToolDefinition<TArgs>;
  args: TArgs;
  state: AgentState;
}

export async function checkPolicyGuard<TArgs>(
  input: PolicyGuardInput<TArgs>,
): Promise<PolicyDecision> {
  const { tool, args, state } = input;

  const allowedTools = toolRegistry.listNames();

  if (!allowedTools.includes(tool.name)) {
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `Tool ${tool.name} is not whitelisted.`,
    };
  }

  if (tool.riskLevel === "low") {
    return {
      allowed: true,
      reason: "Low risk read-only tool is allowed.",
    };
  }

  if (tool.requiresEvidence && state.evidence.length === 0) {
    return {
      allowed: false,
      code: "NO_EVIDENCE",
      reason: "Tool requires evidence, but no evidence was collected.",
    };
  }

  if (tool.name === "refundTransaction") {
    const refundArgs = RefundTransactionArgsSchema.parse(args);

    const transaction = await sandboxClient.get<TransactionSnapshot>(
      `/transactions/${refundArgs.transactionId}`,
      {
        headers: {
          "X-Run-Id": state.runId,
        },
      },
    );

    return canRefundTransaction({
      args: refundArgs,
      transaction,
      evidence: state.evidence,
      previousActions: state.actionsDone,
      policy: {
        maxAutoRefundAmount: 10_000,
        allowedCurrencies: ["RUB"],
      },
    });
  }

  if (tool.riskLevel === "high") {
    return {
      allowed: false,
      code: "FORBIDDEN_TOOL",
      reason: `No explicit policy implemented for high risk tool: ${tool.name}.`,
    };
  }

  return {
    allowed: true,
    reason: "Medium risk tool passed base guard checks.",
  };
}
```

---

## 12.1. Реализованные компоненты

Таблица отражает текущее состояние реализации относительно спецификации.

| Файл | Статус | Примечание |
|---|---|---|
| `src/agent/agentState.ts` | ✅ реализован | Zod-схемы (`AgentStateSchema`, `AgentActionSchema`, `AgentObservationSchema`), типы через `z.infer<>`, фабрика `createInitialAgentState` |
| `src/agent/orchestrator.ts` | ✅ реализован | Детерминированный mock-пайплайн (без LLM), Policy Guard интегрирован, страховочная сетка `buildFallbackAnswer` |
| `src/agent/finalizer.ts` | ✅ реализован | `buildFallbackAnswer` — 4 ветки логики, русская морфология числительных, все ветки ≥ 20 символов |
| `src/policy/rules.ts` | ✅ реализован | `canRefundTransaction` по §11, исправленный порядок проверок |
| `src/policy/policyGuard.ts` | ✅ реализован | Mock transaction store (`MOCK_TRANSACTION_STORE`), логирование всех исходов через `logEvent` |
| `src/llm/outputSchemas.ts` | ✅ реализован | `LlmDecisionSchema` + `parseLlmDecision` + `RefundTransactionArgsSchema` (единственный источник истины) |
| `src/llm/systemPrompt.ts` | ✅ реализован | `buildSystemPrompt()` — 5 секций, 9 правил из §14.3, JSON-примеры для всех трёх вариантов ответа |
| `src/components/AgentTrace.tsx` | ✅ реализован | `"use client"`, discriminated union `TraceState`, inline styles, бейджи по типам наблюдений |
| `app/api/solve/route.ts` | ✅ реализован | `safeParse` на входе, раздельная семантика 400 (невалидный запрос) и 500 (ошибка агента) |
| `src/agent/agentLoop.ts` | ⏳ не реализован | Нужен для LLM-режима (ReAct-цикл с реальными вызовами GigaChat) |
| `src/llm/gigachatClient.ts` | ⏳ не реализован | Подключение GigaChat API |
| `src/sandbox/*Client.ts` | ⏳ не реализован | Реальные HTTP-вызовы в Bank Support Sandbox |

---

## 13. Evidence model

Evidence — это структурированное доказательство, полученное из реального API-ответа песочницы.

```ts
export const EvidenceSchema = z.object({
  id: z.string(),
  source: z.string(),
  objectId: z.string(),
  fact: z.string().min(10),
  supports: z.string().min(5),
  confidence: z.enum(["low", "medium", "high"]),
  createdAt: z.string().datetime(),
});

export type Evidence = z.infer<typeof EvidenceSchema>;
```

Пример evidence:

```json
{
  "id": "ev_001",
  "source": "GET /transactions/tx_993",
  "objectId": "tx_993",
  "fact": "Transaction tx_993 is a completed duplicate subscription charge for 990 RUB.",
  "supports": "refundTransaction:tx_993",
  "confidence": "high",
  "createdAt": "2026-05-22T10:00:00.000Z"
}
```

---

## 14. Системный промпт как reward-функция

Системный промпт должен задавать не просто стиль общения, а правила оптимизации поведения агента.

### 14.1. Что поощряется

| Поведение | Награда |
|---|---|
| Точный API-вызов | Агент получает полезное наблюдение |
| Сбор evidence до действия | Агент может перейти к Policy Check |
| Проверка политики | Агент получает право на high risk action |
| Человечный ответ | Агент успешно завершает кейс |

### 14.2. Что штрафуется

| Поведение | Штраф |
|---|---|
| Галлюцинация фактов | Решение отклоняется |
| Action без evidence | Tool call блокируется |
| Action без policy check | Tool call блокируется |
| Использование запрещённого endpoint | Tool call блокируется |
| Повторный refund | Tool call блокируется |
| Раскрытие технических деталей клиенту | Финальный ответ переписывается |

### 14.3. Базовый system prompt

```text
Ты — Senior Customer Support Agent в банковской поддержке.

Твоя задача — не просто отвечать клиенту, а расследовать проблему через доступные инструменты и безопасно исправлять её, если это разрешено.

Правила:
1. Не делай выводов без evidence.
2. Не выполняй действия без Policy Check.
3. Не вызывай неразрешённые, debug, deprecated, internal, admin и experimental endpoints.
4. Для High Risk действий нужны минимум 2 релевантных evidence.
5. Если данных недостаточно — продолжай расследование.
6. Если политика запрещает действие — не выполняй его.
7. Финальный ответ клиенту должен быть коротким, ясным и человечным.
8. Не раскрывай внутренние endpoint'ы, run_id, transaction_id и технические детали клиенту без необходимости.
9. Возвращай только валидный JSON по заданной схеме.
```

---

## 15. API агента

Минимальный внешний API агента:

| Method | Endpoint | Назначение |
|---|---|---|
| GET | `/health` | Проверка состояния сервиса |
| POST | `/solve` | Запуск решения кейса |
| GET | `/runs/:id` | Получение состояния локального запуска |
| GET | `/runs/:id/trace` | Получение trace Agent Loop |
| GET | `/runs/:id/answer` | Получение финального ответа |

### 15.1. `POST /solve`

```json
{
  "caseId": "case_01_subscription_activation",
  "casePassword": null,
  "dryRun": false
}
```

---

## 16. Docker Compose

```yaml
services:
  bank-sandbox:
    image: lapamore/bank-support-sandbox:latest
    container_name: bank-sandbox
    ports:
      - "8000:8000"

  ai-agent:
    build: .
    container_name: ai-agent
    depends_on:
      - bank-sandbox
    env_file:
      - .env
    environment:
      SANDBOX_URL: http://bank-sandbox:8000
    ports:
      - "8080:8080"
    restart: unless-stopped
```

---

## 17. `.env.example`

```env
NODE_ENV=development
PORT=8080

GIGACHAT_API_KEY=your_key
GIGACHAT_MODEL=GigaChat-2-Pro

SANDBOX_URL=http://bank-sandbox:8000
TEAM_NAME=team-alpha

POSTGRES_DSN=postgresql://support_agent:support_agent_password@postgres:5432/support_agent
REDIS_URL=redis://redis:6379/0

LOG_LEVEL=info
```

---

## 18. Evaluator payload

Финальный результат отправляется в evaluator.

```ts
export const EvaluatePayloadSchema = z.object({
  run_id: z.string(),
  answer: z.string().min(20),
  evidence: z.array(EvidenceSchema).min(1),
  actions: z.array(
    z.object({
      name: z.string(),
      target: z.string(),
      status: z.enum(["success", "failed", "blocked"]),
      reason: z.string(),
    }),
  ),
});
```

Пример:

```json
{
  "run_id": "run_abc123",
  "answer": "Понимаю, ситуация неприятная. Я проверил списания и нашёл повторную оплату. Лишнее списание уже отменено, деньги вернутся на карту в ближайшее время.",
  "evidence": [
    {
      "id": "ev_001",
      "source": "GET /transactions/tx_993",
      "objectId": "tx_993",
      "fact": "Transaction tx_993 is a completed duplicate subscription charge for 990 RUB.",
      "supports": "refundTransaction:tx_993",
      "confidence": "high",
      "createdAt": "2026-05-22T10:00:00.000Z"
    }
  ],
  "actions": [
    {
      "name": "refundTransaction",
      "target": "tx_993",
      "status": "success",
      "reason": "Duplicate completed subscription charge."
    }
  ]
}
```

---

## 19. Observability

Каждый шаг должен попадать в trace.

| Event | Что логируем |
|---|---|
| `run.created` | `runId`, `caseId` |
| `case.loaded` | `caseId`, `ticketId` |
| `llm.decision` | `nextStep`, `toolName`, `reason`, `riskLevel` |
| `tool.called` | `toolName`, `argsHash`, `riskLevel` |
| `tool.observed` | `toolName`, `status`, `objectIds` |
| `evidence.created` | `evidenceId`, `source`, `objectId` |
| `policy.allowed` | `toolName`, `reason` |
| `policy.blocked` | `toolName`, `code`, `reason` |
| `action.executed` | `actionName`, `targetId`, `status` |
| `evaluate.submitted` | `caseId`, `runId` |
| `metrics.received` | evaluator metrics |

---

## 20. Definition of Done

Проект считается готовым, если:

1. Агент запускается через Docker Compose.
2. Backend работает на Node.js + TypeScript.
3. Есть Fastify или Express API.
4. Все LLM JSON-output валидируются через Zod.
5. Все tool args валидируются через Zod перед API-вызовом.
6. Агент создаёт `run`.
7. Агент открывает кейс и intake ticket.
8. Агент работает через Agent Loop: Reason → Act → Observe.
9. Evidence собирается до любого мутирующего действия.
10. High Risk actions проходят через Policy Guard.
11. Запрещённые endpoint’ы недоступны агенту.
12. Есть защита от повторных действий через idempotency key.
13. Финальный ответ отправляется в Evaluator.
14. Метрики и export сохраняются.
15. Trace позволяет восстановить каждое решение агента.
16. Клиентский ответ не содержит технического мусора.

---

## 21. Главная демонстрация на защите

Показывать нужно не просто чат, а полный инженерный trace:

```text
Ticket received
  → run created
  → case opened
  → ticket messages loaded
  → transactions checked
  → duplicate detected
  → evidence collected
  → policy checked
  → refund executed
  → result verified
  → answer generated
  → evaluator accepted
  → metrics exported
```

Ценность проекта в том, что это не чат-бот с шаблонами, а автономный support-агент, который действует как безопасный оператор: расследует, доказывает, проверяет правила, исправляет проблему через API и отчитывается понятным языком.
