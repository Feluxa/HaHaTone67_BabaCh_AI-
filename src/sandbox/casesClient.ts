import { sandboxClient } from "./sandboxClient";

export interface SandboxCase {
  id: string;
  /**
   * Intake block as returned by GET /cases/{case_id}.
   * The support ticket identifier lives at intake.ticket_id.
   */
  intake?: {
    type?: string;
    ticket_id?: string;
    [key: string]: unknown;
  };
  /** Present in some case shapes; the canonical user identifier in most endpoints is user_id. */
  user_id?: string;
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
