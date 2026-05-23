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

/** GET /users/{user_id} — подробная карточка клиента. */
export const GetUserProfileArgsSchema = z.object({
  userId: z.string().min(1),
});

export type GetUserProfileArgs = z.infer<typeof GetUserProfileArgsSchema>;

/** GET /transactions/{transaction_id} — детали конкретной операции. */
export const GetTransactionByIdArgsSchema = z.object({
  transactionId: z.string().min(1),
});

export type GetTransactionByIdArgs = z.infer<typeof GetTransactionByIdArgsSchema>;

/** GET /subscriptions/{subscription_id} — данные конкретной подписки. */
export const GetSubscriptionByIdArgsSchema = z.object({
  subscriptionId: z.string().min(1),
});

export type GetSubscriptionByIdArgs = z.infer<typeof GetSubscriptionByIdArgsSchema>;

/** GET /knowledge-base/search?query={query} — полнотекстовый поиск по базе знаний. */
export const SearchKnowledgeBaseArgsSchema = z.object({
  query: z.string().min(1),
});

export type SearchKnowledgeBaseArgs = z.infer<typeof SearchKnowledgeBaseArgsSchema>;

/** GET /knowledge-base/articles/{article_id} — полный текст статьи по её ID. */
export const GetKnowledgeBaseArticleArgsSchema = z.object({
  articleId: z.string().min(1),
});

export type GetKnowledgeBaseArticleArgs = z.infer<typeof GetKnowledgeBaseArticleArgsSchema>;

/** GET /users/{user_id}/limits — лимиты клиента по картам и операциям. */
export const GetUserLimitsArgsSchema = z.object({
  userId: z.string().min(1),
});

export type GetUserLimitsArgs = z.infer<typeof GetUserLimitsArgsSchema>;

export interface ToolDefinition<TArgs> {
  name: string;
  description: string;
  riskLevel: RiskLevel;
  requiresEvidence: boolean;
  requiresPolicyCheck: boolean;
  inputSchema: z.ZodType<TArgs>;
  execute: (args: TArgs, state: AgentState) => Promise<AgentObservation>;
}
