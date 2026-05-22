import { sandboxClient } from "./sandboxClient";

export interface SandboxCase {
  id: string;
  intakeTicketId?: string;
  ticket_id?: string;
  customerId?: string;
  customer_id?: string;
  [key: string]: unknown;
}

export const casesClient = {
  listCases(): Promise<unknown> {
    return sandboxClient.get("/cases");
  },

  getCase(caseId: string, runId?: string, casePassword?: string): Promise<SandboxCase> {
    return sandboxClient.get<SandboxCase>(`/cases/${caseId}`, {
      runId,
      casePassword,
    });
  },
};
