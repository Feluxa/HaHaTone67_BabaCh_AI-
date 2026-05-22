import { getEnv } from "../config/env";
import { sandboxClient } from "./sandboxClient";

export interface SandboxRun {
  id: string;
}

export const runsClient = {
  createRun(): Promise<SandboxRun> {
    return sandboxClient.post<SandboxRun>("/runs", {
      team_name: getEnv().TEAM_NAME,
      metadata: {
        agent: "hahatone-next-agent",
      },
    });
  },

  getMetrics(runId: string): Promise<unknown> {
    return sandboxClient.get(`/runs/${runId}/metrics`);
  },

  getExport(runId: string): Promise<unknown> {
    return sandboxClient.get(`/runs/${runId}/export`);
  },
};
