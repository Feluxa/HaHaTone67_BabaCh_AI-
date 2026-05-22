import { z } from "zod";
import type { AgentObservation, AgentState, RiskLevel } from "../agent/agentState";

// RefundTransactionArgsSchema живёт в outputSchemas.ts (§9.3 ARCHITECTURE) —
// там валидируются все аргументы, которые предлагает LLM.
// Реэкспортируем для обратной совместимости всех существующих импортов.
export {
  RefundTransactionArgsSchema,
  type RefundTransactionArgs,
} from "../llm/outputSchemas";

export const GetTicketMessagesArgsSchema = z.object({
  ticketId: z.string().min(1),
});

export type GetTicketMessagesArgs = z.infer<typeof GetTicketMessagesArgsSchema>;

export const GetCustomerProfileArgsSchema = z.object({
  customerId: z.string().min(1),
});

export type GetCustomerProfileArgs = z.infer<typeof GetCustomerProfileArgsSchema>;

export const GetTransactionsArgsSchema = z.object({
  customerId: z.string().min(1),
  limit: z.number().int().positive().max(100).default(50),
});

export type GetTransactionsArgs = z.infer<typeof GetTransactionsArgsSchema>;

export interface ToolDefinition<TArgs> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresEvidence: boolean;
  requiresPolicyCheck: boolean;
  inputSchema: z.ZodType<TArgs>;
  execute: (args: TArgs, state: AgentState) => Promise<AgentObservation>;
}
