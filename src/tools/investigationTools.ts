import { sandboxClient } from "../sandbox/sandboxClient";
import {
  type GetCustomerProfileArgs,
  GetCustomerProfileArgsSchema,
  type GetTicketMessagesArgs,
  GetTicketMessagesArgsSchema,
  type GetTransactionsArgs,
  GetTransactionsArgsSchema,
  type GetUserProfileArgs,
  GetUserProfileArgsSchema,
  type GetTransactionByIdArgs,
  GetTransactionByIdArgsSchema,
  type GetSubscriptionByIdArgs,
  GetSubscriptionByIdArgsSchema,
  type SearchKnowledgeBaseArgs,
  SearchKnowledgeBaseArgsSchema,
  type ToolDefinition,
} from "./toolSchemas";

/**
 * Fetches the support ticket card (GET /support/tickets/{ticket_id}).
 *
 * The ticket card is the canonical source for the customer identifier: the
 * sandbox always returns `user_id` in this response. Fetching `/messages`
 * instead would only return the conversation thread without the user reference.
 */
export const getTicketMessagesTool: ToolDefinition<GetTicketMessagesArgs> = {
  name: "getTicketMessages",
  description:
    "Load support ticket card from the bank sandbox. Returns ticket metadata including user_id that identifies the customer.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetTicketMessagesArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/support/tickets/${args.ticketId}`,
      { runId: state.runId },
    );

    return {
      type: "ticket_messages",
      source: `GET /support/tickets/${args.ticketId}`,
      status: "success",
      data,
    };
  },
};

/**
 * Fetches active subscriptions for the customer (GET /users/{user_id}/subscriptions).
 *
 * The sandbox uses /users/{user_id}/... as the canonical path for all
 * customer-scoped resources. The legacy /customers/{id} path does not exist.
 */
export const getCustomerProfileTool: ToolDefinition<GetCustomerProfileArgs> = {
  name: "getCustomerProfile",
  description:
    "Load customer subscriptions and service statuses from the bank sandbox via GET /users/{user_id}/subscriptions.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetCustomerProfileArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/users/${args.customerId}/subscriptions`,
      { runId: state.runId },
    );

    return {
      type: "customer_profile",
      source: `GET /users/${args.customerId}/subscriptions`,
      status: "success",
      data,
    };
  },
};

/**
 * Fetches transactions for the customer (GET /users/{user_id}/transactions).
 *
 * The sandbox exposes transactions as a sub-resource of the user, not via a
 * global /transactions query string endpoint. The limit parameter is passed as
 * a query string supported by the sandbox.
 */
export const getTransactionsTool: ToolDefinition<GetTransactionsArgs> = {
  name: "getTransactions",
  description:
    "Load recent customer transactions from the bank sandbox via GET /users/{user_id}/transactions.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetTransactionsArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/users/${args.customerId}/transactions?limit=${args.limit}`,
      { runId: state.runId },
    );

    return {
      type: "transactions",
      source: `GET /users/${args.customerId}/transactions`,
      status: "success",
      data,
    };
  },
};

/**
 * Fetches the detailed user profile card (GET /users/{user_id}).
 *
 * Returns the canonical customer record: name, contact info, KYC status, etc.
 * This is distinct from /users/{user_id}/subscriptions which lists services only.
 */
export const getUserProfileTool: ToolDefinition<GetUserProfileArgs> = {
  name: "getUserProfile",
  description:
    "Load detailed customer profile card from the bank sandbox via GET /users/{user_id}.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetUserProfileArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/users/${args.userId}`,
      { runId: state.runId },
    );

    return {
      type: "user_profile_detail",
      source: `GET /users/${args.userId}`,
      status: "success",
      data,
    };
  },
};

/**
 * Fetches a single transaction by its ID (GET /transactions/{transaction_id}).
 *
 * Used to confirm the details of the specific payment linked to the case,
 * e.g. the source_transaction_id from the subscription record.
 */
export const getTransactionByIdTool: ToolDefinition<GetTransactionByIdArgs> = {
  name: "getTransactionById",
  description:
    "Load a single transaction by ID from the bank sandbox via GET /transactions/{transaction_id}.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetTransactionByIdArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/transactions/${args.transactionId}`,
      { runId: state.runId },
    );

    return {
      type: "transaction_detail",
      source: `GET /transactions/${args.transactionId}`,
      status: "success",
      data,
    };
  },
};

/**
 * Fetches a single subscription by its ID (GET /subscriptions/{subscription_id}).
 *
 * Returns full subscription metadata including plan, status, activation_error,
 * and provider details — richer than the user-scoped list endpoint.
 */
export const getSubscriptionByIdTool: ToolDefinition<GetSubscriptionByIdArgs> = {
  name: "getSubscriptionById",
  description:
    "Load a single subscription by ID from the bank sandbox via GET /subscriptions/{subscription_id}.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetSubscriptionByIdArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/subscriptions/${args.subscriptionId}`,
      { runId: state.runId },
    );

    return {
      type: "subscription_detail",
      source: `GET /subscriptions/${args.subscriptionId}`,
      status: "success",
      data,
    };
  },
};

/**
 * Searches the knowledge base (GET /knowledge-base/search?query={query}).
 *
 * Returns matching articles ranked by relevance. Used to find resolution
 * procedures for known issue patterns before formulating the agent's answer.
 */
export const searchKnowledgeBaseTool: ToolDefinition<SearchKnowledgeBaseArgs> = {
  name: "searchKnowledgeBase",
  description:
    "Search the knowledge base for relevant articles via GET /knowledge-base/search?query={query}.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: SearchKnowledgeBaseArgsSchema,
  async execute(args, state) {
    const encodedQuery = encodeURIComponent(args.query);
    const data = await sandboxClient.get(
      `/knowledge-base/search?q=${encodedQuery}`,
      { runId: state.runId },
    );

    return {
      type: "knowledge_base_search",
      source: `GET /knowledge-base/search?query=${encodedQuery}`,
      status: "success",
      data,
    };
  },
};

export const investigationTools = [
  getTicketMessagesTool,
  getCustomerProfileTool,
  getTransactionsTool,
  getUserProfileTool,
  getTransactionByIdTool,
  getSubscriptionByIdTool,
  searchKnowledgeBaseTool,
];
