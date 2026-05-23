"use client";

import { useState } from "react";
import type { AgentAction, AgentObservation, AgentState } from "../agent/agentState";

// ─────────────────────────────────────────────────────────────
// API response contract
// ─────────────────────────────────────────────────────────────

interface SolveResponse {
  state: AgentState;
  /** null когда dryRun:true или evaluator не вернул данных. */
  evaluation: unknown | null;
  metrics: Record<string, unknown>;
  exportData: unknown | null;
}

// ─────────────────────────────────────────────────────────────
// Local state — discriminated union, строгая типизация
//
// mode хранится и в loading, и в success, чтобы:
//  - крутить спиннер только на нажатой кнопке
//  - показывать секцию evaluation только после реального сабмита
// ─────────────────────────────────────────────────────────────

type RunMode = "dryRun" | "evaluate";

type TraceState =
  | { status: "idle" }
  | { status: "loading"; mode: RunMode }
  | { status: "error"; message: string }
  | { status: "success"; data: SolveResponse; mode: RunMode };

// ─────────────────────────────────────────────────────────────
// Style helpers
// ─────────────────────────────────────────────────────────────

const OBS_TYPE_COLORS: Record<string, { bg: string; fg: string }> = {
  tool_result:    { bg: "#dbe4ff", fg: "#1971c2" },
  policy_allowed: { bg: "#d3f9d8", fg: "#2f9e44" },
  policy_blocked: { bg: "#ffe3e3", fg: "#c92a2a" },
};

function obsTypeBadge(type: string): React.CSSProperties {
  const { bg, fg } = OBS_TYPE_COLORS[type] ?? { bg: "#e9ecef", fg: "#495057" };
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
    backgroundColor: bg,
    color: fg,
    letterSpacing: 0.3,
    whiteSpace: "nowrap" as const,
  };
}

const CONFIDENCE_COLORS: Record<
  AgentState["evidence"][number]["confidence"],
  { bg: string; fg: string }
> = {
  high:   { bg: "#d3f9d8", fg: "#2f9e44" },
  medium: { bg: "#fff3bf", fg: "#e67700" },
  low:    { bg: "#f1f3f5", fg: "#868e96" },
};

function confidenceBadge(
  confidence: AgentState["evidence"][number]["confidence"],
): React.CSSProperties {
  const { bg, fg } = CONFIDENCE_COLORS[confidence];
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
    backgroundColor: bg,
    color: fg,
  };
}

const STATUS_DOT_COLOR: Record<AgentObservation["status"], string> = {
  success: "#40c057",
  failed:  "#e03131",
  blocked: "#e67700",
};

const ACTION_STATUS_COLORS: Record<AgentAction["status"], { bg: string; fg: string }> = {
  planned: { bg: "#f1f3f5", fg: "#495057" },
  success: { bg: "#d3f9d8", fg: "#2f9e44" },
  failed:  { bg: "#ffe3e3", fg: "#c92a2a" },
  blocked: { bg: "#fff4e6", fg: "#e67700" },
};

function actionStatusBadge(status: AgentAction["status"]): React.CSSProperties {
  const { bg, fg } = ACTION_STATUS_COLORS[status];
  return {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 4,
    fontSize: 11,
    fontWeight: 700,
    backgroundColor: bg,
    color: fg,
    whiteSpace: "nowrap" as const,
  };
}

/**
 * Преобразует значение unknown в строку для отображения в таблице метрик.
 * Не использует any — все случаи обработаны через typeof.
 */
function renderMetricValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <h3
      style={{
        fontSize: 12,
        fontWeight: 700,
        color: "#495057",
        textTransform: "uppercase",
        letterSpacing: 0.8,
        margin: "0 0 12px 0",
        borderBottom: "1px solid #e9ecef",
        paddingBottom: 6,
      }}
    >
      {children}
    </h3>
  );
}

function ObservationsPanel({
  observations,
}: {
  observations: AgentObservation[];
}): React.ReactElement {
  if (observations.length === 0) {
    return <p style={{ color: "#868e96", fontSize: 13, margin: 0 }}>Нет наблюдений</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {observations.map((obs, idx) => (
        <div
          key={idx}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
            padding: "10px 14px",
            borderRadius: 6,
            backgroundColor: "#f8f9fa",
            border: "1px solid #e9ecef",
          }}
        >
          <span
            style={{
              minWidth: 22,
              height: 22,
              borderRadius: "50%",
              backgroundColor: "#dee2e6",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 11,
              fontWeight: 700,
              color: "#495057",
              flexShrink: 0,
            }}
          >
            {idx + 1}
          </span>

          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                flexWrap: "wrap" as const,
                marginBottom: 5,
              }}
            >
              <span style={obsTypeBadge(obs.type)}>{obs.type}</span>
              <span
                title={obs.status}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  backgroundColor: STATUS_DOT_COLOR[obs.status],
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 11, color: "#868e96" }}>{obs.status}</span>
            </div>

            <div style={{ fontSize: 12, color: "#495057", marginBottom: 3 }}>
              <span style={{ color: "#adb5bd" }}>source: </span>
              <code
                style={{
                  fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
                  fontSize: 12,
                  backgroundColor: "#e9ecef",
                  padding: "0 4px",
                  borderRadius: 3,
                }}
              >
                {obs.source}
              </code>
            </div>

            {obs.message !== undefined && (
              <p
                style={{
                  fontSize: 13,
                  color: "#343a40",
                  margin: "4px 0 0 0",
                  lineHeight: 1.5,
                }}
              >
                {obs.message}
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function EvidencePanel({
  evidence,
}: {
  evidence: AgentState["evidence"];
}): React.ReactElement {
  if (evidence.length === 0) {
    return (
      <p style={{ color: "#868e96", fontSize: 13, margin: 0 }}>
        Доказательства не собраны
      </p>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {evidence.map((ev) => (
        <div
          key={ev.id}
          style={{
            padding: "10px 14px",
            borderRadius: 6,
            backgroundColor: "#f8f9fa",
            border: "1px solid #e9ecef",
          }}
        >
          <div
            style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}
          >
            <code
              style={{
                fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
                fontSize: 12,
                color: "#1971c2",
                backgroundColor: "#e7f5ff",
                padding: "1px 5px",
                borderRadius: 3,
              }}
            >
              {ev.id}
            </code>
            <span style={confidenceBadge(ev.confidence)}>{ev.confidence}</span>
          </div>

          <div style={{ fontSize: 12, color: "#868e96", marginBottom: 5 }}>
            <span>source: </span>
            <code
              style={{
                fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
                fontSize: 12,
              }}
            >
              {ev.source}
            </code>
          </div>

          <p
            style={{
              fontSize: 13,
              color: "#212529",
              margin: 0,
              lineHeight: 1.55,
            }}
          >
            {ev.fact}
          </p>
        </div>
      ))}
    </div>
  );
}

function ActionCard({ action }: { action: AgentAction }): React.ReactElement {
  return (
    <div
      style={{
        padding: "10px 14px",
        borderRadius: 6,
        backgroundColor: "#f8f9fa",
        border: "1px solid #e9ecef",
      }}
    >
      <div
        style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 5 }}
      >
        <code
          style={{
            fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
            fontSize: 12,
            color: "#1971c2",
            backgroundColor: "#e7f5ff",
            padding: "1px 5px",
            borderRadius: 3,
          }}
        >
          {action.name}
        </code>
        <span style={actionStatusBadge(action.status)}>{action.status}</span>
      </div>

      <div style={{ fontSize: 12, color: "#868e96", marginBottom: 5 }}>
        <span>target: </span>
        <code
          style={{
            fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
            fontSize: 12,
          }}
        >
          {action.targetId}
        </code>
      </div>

      <p style={{ fontSize: 13, color: "#343a40", margin: 0, lineHeight: 1.5 }}>
        {action.reason}
      </p>
    </div>
  );
}

function ActionsPanel({
  actionsPlanned,
  actionsDone,
}: {
  actionsPlanned: AgentState["actionsPlanned"];
  actionsDone: AgentState["actionsDone"];
}): React.ReactElement {
  const isEmpty = actionsPlanned.length === 0 && actionsDone.length === 0;

  if (isEmpty) {
    return <p style={{ color: "#868e96", fontSize: 13, margin: 0 }}>Действий нет</p>;
  }

  const subLabel: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "#adb5bd",
    textTransform: "uppercase" as const,
    letterSpacing: 0.5,
    margin: "0 0 8px 0",
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {actionsPlanned.length > 0 && (
        <div>
          <p style={subLabel}>Запланированные ({actionsPlanned.length})</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {actionsPlanned.map((action, idx) => (
              <ActionCard key={idx} action={action} />
            ))}
          </div>
        </div>
      )}

      {actionsDone.length > 0 && (
        <div>
          <p style={subLabel}>Выполненные ({actionsDone.length})</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {actionsDone.map((action, idx) => (
              <ActionCard key={idx} action={action} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function MetricsPanel({
  metrics,
}: {
  metrics: Record<string, unknown>;
}): React.ReactElement {
  const entries = Object.entries(metrics);

  if (entries.length === 0) {
    return <p style={{ color: "#868e96", fontSize: 13, margin: 0 }}>Нет метрик</p>;
  }

  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
      <tbody>
        {entries.map(([key, value]) => (
          <tr key={key} style={{ borderBottom: "1px solid #f1f3f5" }}>
            <td
              style={{
                padding: "6px 12px 6px 0",
                color: "#868e96",
                fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
                fontSize: 12,
                verticalAlign: "top",
                whiteSpace: "nowrap" as const,
                width: "40%",
              }}
            >
              {key}
            </td>
            <td
              style={{
                padding: "6px 0",
                color: "#212529",
                fontWeight: 500,
                verticalAlign: "top",
                wordBreak: "break-all" as const,
              }}
            >
              {renderMetricValue(value)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Панель результата оценки от evaluator.
 *
 * `evaluation` — это `unknown` (sandbox может изменить схему ответа),
 * поэтому отображаем через JSON.stringify без кастов.
 */
function EvaluationPanel({ evaluation }: { evaluation: unknown }): React.ReactElement {
  if (evaluation === null || evaluation === undefined) {
    return (
      <p style={{ color: "#868e96", fontSize: 13, margin: 0 }}>
        Результат оценки не получен
      </p>
    );
  }

  // Если evaluator вернул объект, красиво форматируем; иначе — строка/число.
  const rendered =
    typeof evaluation === "object"
      ? JSON.stringify(evaluation, null, 2)
      : String(evaluation);

  return (
    <pre
      style={{
        margin: 0,
        fontSize: 12,
        fontFamily: "'Fira Code', 'Cascadia Code', Consolas, monospace",
        color: "#212529",
        backgroundColor: "#f8f9fa",
        border: "1px solid #e9ecef",
        borderRadius: 6,
        padding: "12px 14px",
        overflowX: "auto",
        whiteSpace: "pre-wrap" as const,
        wordBreak: "break-word" as const,
        lineHeight: 1.55,
      }}
    >
      {rendered}
    </pre>
  );
}

// ─────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────

export function AgentTrace(): React.ReactElement {
  const [trace, setTrace] = useState<TraceState>({ status: "idle" });

  /**
   * Единая точка запуска агента.
   *
   * dryRun: true  → ▶ Run Agent (dry-run)   — только трейс, без evaluator
   * dryRun: false → 📤 Submit to Evaluator   — полный запуск + POST /cases/{id}/evaluate
   */
  async function handleRunAgent(dryRun: boolean): Promise<void> {
    const mode: RunMode = dryRun ? "dryRun" : "evaluate";
    setTrace({ status: "loading", mode });

    try {
      const res = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId: "case_01_subscription_activation", dryRun }),
      });

      const json: unknown = await res.json();

      if (!res.ok) {
        const errMsg =
          typeof json === "object" &&
          json !== null &&
          "error" in json &&
          typeof (json as { error: unknown }).error === "string"
            ? (json as { error: string }).error
            : `HTTP ${res.status}`;
        setTrace({ status: "error", message: errMsg });
        return;
      }

      if (typeof json !== "object" || json === null || !("state" in json)) {
        setTrace({
          status: "error",
          message: "Неожиданная структура ответа от /api/solve",
        });
        return;
      }

      setTrace({ status: "success", data: json as SolveResponse, mode });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ошибка сети";
      setTrace({ status: "error", message });
    }
  }

  const isLoading = trace.status === "loading";

  return (
    <div style={{ fontFamily: "Inter, system-ui, -apple-system, sans-serif" }}>
      {/* ── Кнопки запуска ─────────────────────────────────────────────────── */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {/* Dry-run — только трейс, evaluator не вызывается */}
        <button
          type="button"
          onClick={() => handleRunAgent(true)}
          disabled={isLoading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            backgroundColor:
              isLoading && trace.mode === "dryRun" ? "#74c0fc" : "#228be6",
            border: "none",
            borderRadius: 6,
            cursor: isLoading ? "not-allowed" : "pointer",
            transition: "background-color 0.15s ease",
            opacity: isLoading && trace.mode === "evaluate" ? 0.6 : 1,
          }}
        >
          {isLoading && trace.mode === "dryRun"
            ? "⏳ Запуск..."
            : "▶ Run Agent (dry-run)"}
        </button>

        {/*
          Submit to Evaluator — dryRun:false.
          Оркестратор вызовет POST /cases/{caseId}/evaluate через evaluatorClient
          и вернёт поле evaluation в теле ответа.
        */}
        <button
          type="button"
          onClick={() => handleRunAgent(false)}
          disabled={isLoading}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            backgroundColor:
              isLoading && trace.mode === "evaluate" ? "#63e6be" : "#0ca678",
            border: "none",
            borderRadius: 6,
            cursor: isLoading ? "not-allowed" : "pointer",
            transition: "background-color 0.15s ease",
            opacity: isLoading && trace.mode === "dryRun" ? 0.6 : 1,
          }}
        >
          {isLoading && trace.mode === "evaluate"
            ? "⏳ Отправка..."
            : "📤 Submit to Evaluator"}
        </button>
      </div>

      {/* ── Loading ─────────────────────────────────────────────────────────── */}
      {trace.status === "loading" && (
        <p style={{ color: "#868e96", fontSize: 13, margin: 0 }}>
          {trace.mode === "dryRun"
            ? "Агент расследует кейс, ждём ответа..."
            : "Агент работает и отправляет решение в evaluator..."}
        </p>
      )}

      {/* ── Error ───────────────────────────────────────────────────────────── */}
      {trace.status === "error" && (
        <div
          style={{
            padding: "12px 16px",
            borderRadius: 6,
            backgroundColor: "#fff5f5",
            border: "1px solid #ffa8a8",
            color: "#c92a2a",
            fontSize: 14,
          }}
        >
          <strong>Ошибка: </strong>
          {trace.message}
        </div>
      )}

      {/* ── Success / Trace ─────────────────────────────────────────────────── */}
      {trace.status === "success" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {/* Run metadata */}
          <div
            style={{
              fontSize: 11,
              color: "#adb5bd",
              fontFamily: "'Fira Code', Consolas, monospace",
            }}
          >
            runId: {trace.data.state.runId} · caseId: {trace.data.state.caseId}
            {trace.mode === "evaluate" && (
              <span
                style={{
                  marginLeft: 10,
                  padding: "1px 7px",
                  borderRadius: 4,
                  backgroundColor: "#d3f9d8",
                  color: "#2f9e44",
                  fontWeight: 700,
                  fontSize: 10,
                }}
              >
                EVALUATED
              </span>
            )}
          </div>

          {/* Observations */}
          <section>
            <SectionTitle>
              Observations ({trace.data.state.observations.length})
            </SectionTitle>
            <ObservationsPanel observations={trace.data.state.observations} />
          </section>

          {/* Evidence */}
          <section>
            <SectionTitle>
              Evidence ({trace.data.state.evidence.length})
            </SectionTitle>
            <EvidencePanel evidence={trace.data.state.evidence} />
          </section>

          {/* Actions */}
          <section>
            <SectionTitle>
              Actions (planned: {trace.data.state.actionsPlanned.length} · done:{" "}
              {trace.data.state.actionsDone.length})
            </SectionTitle>
            <ActionsPanel
              actionsPlanned={trace.data.state.actionsPlanned}
              actionsDone={trace.data.state.actionsDone}
            />
          </section>

          {/* Metrics */}
          <section>
            <SectionTitle>Metrics</SectionTitle>
            <MetricsPanel metrics={trace.data.metrics} />
          </section>

          {/* Evaluation result — только после реального сабмита */}
          {trace.mode === "evaluate" && (
            <section
              style={{
                padding: "16px 20px",
                borderRadius: 8,
                backgroundColor: "#ebfbee",
                border: "1px solid #8ce99a",
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#2f9e44",
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  margin: "0 0 10px 0",
                }}
              >
                Результат Evaluator · POST /cases/case_01_subscription_activation/evaluate
              </p>
              <EvaluationPanel evaluation={trace.data.evaluation} />
            </section>
          )}

          {/* Final answer — не трогать */}
          {trace.data.state.answer !== undefined && (
            <section
              style={{
                padding: "16px 20px",
                borderRadius: 8,
                backgroundColor: "#f3f0ff",
                border: "1px solid #b197fc",
              }}
            >
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#7048e8",
                  textTransform: "uppercase",
                  letterSpacing: 0.8,
                  margin: "0 0 10px 0",
                }}
              >
                Финальный ответ агента
              </p>
              <p
                style={{
                  fontSize: 16,
                  color: "#2f2060",
                  margin: 0,
                  lineHeight: 1.6,
                  fontWeight: 500,
                }}
              >
                {trace.data.state.answer}
              </p>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
