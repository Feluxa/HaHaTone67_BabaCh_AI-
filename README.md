# Bank Support AI Agent

Автономный агент поддержки клиентов, работающий по принципу ReAct (Reason → Act → Observe). Получает тикет обращения, расследует проблему через API банковской песочницы, собирает доказательства, проверяет бизнес-правила и выполняет только разрешённые действия. LLM (GigaChat) предлагает шаги, backend валидирует и исполняет их.

## Запуск

### 1. Sandbox (Bank Support Sandbox API)

```bash
docker run -p 8000:8000 lapamore/bank-support-sandbox:latest
```

Sandbox будет доступен на `http://localhost:8000`. Агент обращается к нему через переменную `SANDBOX_URL`.

### 2. Приложение

```bash
npm install
npm run dev
```

Откройте `http://localhost:3000`. Для production-сборки: `npm run build && npm start`.

### 3. Переменные окружения

Скопируйте `.env.example` в `.env` и заполните:

```env
NODE_ENV=development
SANDBOX_URL=http://localhost:8000
TEAM_NAME=team-alpha
GIGACHAT_API_KEY=your_key
GIGACHAT_MODEL=GigaChat-2-Pro
LOG_LEVEL=info
```

## API

| Method | Endpoint | Назначение |
|---|---|---|
| `GET` | `/api/health` | Статус сервиса |
| `POST` | `/api/solve` | Запуск расследования кейса |

Тело запроса `/api/solve`:

```json
{
  "caseId": "case_01_subscription_activation",
  "dryRun": true
}
```

`dryRun: true` — расследование без реальных мутаций в Sandbox.

## Интерфейс

На главной странице — кнопка **▶ Run Agent (dry-run)**. После нажатия последовательно появляются:

- **Observations** — каждый шаг ReAct-цикла: тип (бейдж с цветом), источник, сообщение
- **Evidence** — собранные доказательства: id, confidence (high/medium/low), факт
- **Actions** — запланированные и выполненные действия: имя инструмента, target, статус, обоснование
- **Metrics** — таблица метрик прогона (шаги, evidence, действия, режим)
- **Финальный ответ** — человекочитаемый вывод агента

## Архитектурные решения

### LLM не вызывает API напрямую

GigaChat возвращает только JSON с описанием следующего шага (`tool_call`, `final_answer`, `need_more_info`). Backend парсит этот JSON через Zod, проверяет валидность, прогоняет через Policy Guard и только после этого исполняет HTTP-вызов к Sandbox. Это исключает галлюцинации, несанкционированные действия и повторные списания.

### Evidence-First

Агент не может выполнить мутирующее действие (Medium/High risk) без предварительно собранных доказательств. Факты собираются низкорисковыми инструментами (`getTicketMessages`, `getCustomerProfile`, `getTransactions`) и валидируются через `EvidenceSchema`. Для High Risk действий требуется минимум 2 релевантных evidence.

### Policy Guard

Каждый High Risk вызов проходит через `checkPolicyGuard` перед исполнением. Guard проверяет: whitelist инструментов, наличие evidence, принадлежность транзакции клиенту, статус объекта, отсутствие повторного действия, лимиты суммы и валюты. Результат — `PolicyDecision` (allowed/blocked с кодом причины), который записывается в `observations` и логируется.

## Структура `src/`

```
src/
├── agent/
│   ├── agentState.ts        # Zod-схемы AgentState, AgentAction, AgentObservation; фабрика
│   ├── orchestrator.ts      # solveCase() — детерминированный пайплайн (mock, без LLM)
│   ├── agentLoop.ts         # ReAct-цикл с GigaChat (⏳ подключается следующим этапом)
│   └── finalizer.ts         # buildFallbackAnswer() — 4 ветки, русская морфология
│
├── llm/
│   ├── outputSchemas.ts     # LlmDecisionSchema, parseLlmDecision, RefundTransactionArgsSchema
│   ├── systemPrompt.ts      # buildSystemPrompt() — роль, правила, JSON-примеры
│   └── gigachatClient.ts    # HTTP-клиент GigaChat (⏳)
│
├── policy/
│   ├── rules.ts             # canRefundTransaction() — бизнес-правила возврата
│   ├── policyGuard.ts       # checkPolicyGuard() — точка входа, mock transaction store
│   └── policyEngine.ts      # checkRefundPolicy() — реальный вызов Sandbox (⏳)
│
├── tools/
│   ├── toolRegistry.ts      # ToolRegistry — whitelist инструментов
│   ├── toolSchemas.ts       # ToolDefinition<TArgs>, схемы аргументов investigation-инструментов
│   ├── investigationTools.ts  # getTicketMessages, getCustomerProfile, getTransactions
│   └── actionTools.ts       # refundTransaction
│
├── sandbox/
│   ├── sandboxClient.ts     # HTTP-клиент Sandbox (Axios/Undici)
│   ├── casesClient.ts       # GET /cases/{id}
│   ├── runsClient.ts        # POST /runs, GET /runs/{id}/metrics|export
│   └── evaluatorClient.ts   # POST /cases/{id}/evaluate
│
├── evidence/
│   ├── evidenceTypes.ts     # EvidenceSchema, type Evidence
│   └── evidenceCollector.ts # extractEvidenceFromObservation()
│
├── observability/
│   ├── logger.ts            # logEvent(level, event, payload)
│   └── trace.ts             # traceDecision()
│
└── components/
    └── AgentTrace.tsx       # "use client" — UI трейса агента, discriminated union TraceState
```
