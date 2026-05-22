"use client";

import { useState } from "react";
import type { AgentAction, AgentObservation, AgentState } from "../agent/agentState";

// ─────────────────────────────────────────────────────────────
// API response contract
// ─────────────────────────────────────────────────────────────

interface SolveResponse {
  state: AgentState;
  metrics: Record<string, unknown>;
  exportData: null;
}

// ─────────────────────────────────────────────────────────────
// Local state — discriminated union, строгая типизация
// ─────────────────────────────────────────────────────────────

type TraceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; data: SolveResponse };

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

// planned → серый, success → зелёный, failed → красный, blocked → оранжевый
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
          {/* Step number badge */}
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
            {/* Type badge + status dot */}
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

            {/* Source */}
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

            {/* Message */}
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
          {/* ID + confidence */}
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

          {/* Source */}
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

          {/* Fact */}
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

// Карточка одного действия — используется и в planned, и в done.
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
      {/* name + status badge */}
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

      {/* targetId */}
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

      {/* reason */}
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

// ─────────────────────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────────────────────

export function AgentTrace(): React.ReactElement {
  const [trace, setTrace] = useState<TraceState>({ status: "idle" });

  async function handleRunAgent(): Promise<void> {
    setTrace({ status: "loading" });

    try {
      const res = await fetch("/api/solve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ caseId: "case_01", dryRun: true }),
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

      // Минимальная runtime-проверка формы ответа перед кастом
      if (typeof json !== "object" || json === null || !("state" in json)) {
        setTrace({
          status: "error",
          message: "Неожиданная структура ответа от /api/solve",
        });
        return;
      }

      setTrace({ status: "success", data: json as SolveResponse });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Ошибка сети";
      setTrace({ status: "error", message });
    }
  }

  return (
    <div style={{ fontFamily: "Inter, system-ui, -apple-system, sans-serif" }}>
      {/* ── Кнопка запуска ─────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
        <button
          type="button"
          onClick={handleRunAgent}
          disabled={trace.status === "loading"}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 20px",
            fontSize: 14,
            fontWeight: 600,
            color: "#fff",
            backgroundColor: trace.status === "loading" ? "#74c0fc" : "#228be6",
            border: "none",
            borderRadius: 6,
            cursor: trace.status === "loading" ? "not-allowed" : "pointer",
            transition: "background-color 0.15s ease",
          }}
        >
          {trace.status === "loading" ? "⏳ Запуск..." : "▶ Run Agent (dry-run)"}
        </button>
      </div>

      {/* ── Loading ─────────────────────────────────────────── */}
      {trace.status === "loading" && (
        <p style={{ color: "#868e96", fontSize: 13, margin: 0 }}>
          Агент расследует кейс, ждём ответа...
        </p>
      )}

      {/* ── Error ───────────────────────────────────────────── */}
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

      {/* ── Success / Trace ─────────────────────────────────── */}
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
              Actions (planned: {trace.data.state.actionsPlanned.length} · done: {trace.data.state.actionsDone.length})
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
