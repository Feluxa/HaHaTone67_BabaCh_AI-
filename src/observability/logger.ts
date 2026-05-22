export type LogLevel = "debug" | "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, payload: unknown): void {
  const record = {
    level,
    event,
    payload,
    time: new Date().toISOString(),
  };

  if (level === "error") {
    console.error(record);
    return;
  }

  console.log(record);
}
