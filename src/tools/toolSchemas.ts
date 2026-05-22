import { z } from "zod";
import type { AgentObservation, AgentState, RiskLevel } from "../agent/agentState";

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

export const RefundTransactionArgsSchema = z.object({
  transactionId: z.string().min(1),
  customerId: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().length(3),
  reason: z.string().min(10).max(500),
  idempotencyKey: z.string().min(16),
});

export type RefundTransactionArgs = z.infer<typeof RefundTransactionArgsSchema>;

export interface ToolDefinition<TArgs> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresEvidence: boolean;
  requiresPolicyCheck: boolean;
  inputSchema: z.ZodType<TArgs>;
  execute: (args: TArgs, state: AgentState) => Promise<AgentObservation>;
}
