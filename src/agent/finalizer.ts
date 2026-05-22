import type { AgentState } from "./agentState";

export function buildFallbackAnswer(state: AgentState): string {
  if (state.evidence.length === 0) {
    return "Я начал проверку обращения, но пока не смог собрать достаточно фактов для безопасного решения.";
  }

  return "Я проверил доступные данные по обращению. Для выполнения действия нужны дополнительные проверки политики.";
}
