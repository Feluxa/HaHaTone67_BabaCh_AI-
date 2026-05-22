import { sandboxClient } from "../sandbox/sandboxClient";
import {
  type GetCustomerProfileArgs,
  GetCustomerProfileArgsSchema,
  type GetTicketMessagesArgs,
  GetTicketMessagesArgsSchema,
  type GetTransactionsArgs,
  GetTransactionsArgsSchema,
  type ToolDefinition,
} from "./toolSchemas";

export const getTicketMessagesTool: ToolDefinition<GetTicketMessagesArgs> = {
  name: "getTicketMessages",
  description: "Load support ticket messages from the bank sandbox.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetTicketMessagesArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/support/tickets/${args.ticketId}/messages`,
      { runId: state.runId },
    );

    return {
      type: "ticket_messages",
      source: `GET /support/tickets/${args.ticketId}/messages`,
      status: "success",
      data,
    };
  },
};

export const getCustomerProfileTool: ToolDefinition<GetCustomerProfileArgs> = {
  name: "getCustomerProfile",
  description: "Load customer profile from the bank sandbox.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetCustomerProfileArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(`/customers/${args.customerId}`, {
      runId: state.runId,
    });

    return {
      type: "customer_profile",
      source: `GET /customers/${args.customerId}`,
      status: "success",
      data,
    };
  },
};

export const getTransactionsTool: ToolDefinition<GetTransactionsArgs> = {
  name: "getTransactions",
  description: "Load recent customer transactions from the bank sandbox.",
  riskLevel: "low",
  requiresEvidence: false,
  requiresPolicyCheck: false,
  inputSchema: GetTransactionsArgsSchema,
  async execute(args, state) {
    const data = await sandboxClient.get(
      `/transactions?customer_id=${encodeURIComponent(args.customerId)}&limit=${args.limit}`,
      { runId: state.runId },
    );

    return {
      type: "transactions",
      source: "GET /transactions",
      status: "success",
      data,
    };
  },
};

export const investigationTools = [
  getTicketMessagesTool,
  getCustomerProfileTool,
  getTransactionsTool,
];
