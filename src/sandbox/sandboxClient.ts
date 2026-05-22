import { getEnv } from "../config/env";

export interface SandboxRequestOptions {
  runId?: string;
  casePassword?: string;
  headers?: Record<string, string>;
}

export class SandboxClient {
  constructor(private readonly baseUrl = getEnv().SANDBOX_URL) {}

  async get<T>(path: string, options: SandboxRequestOptions = {}): Promise<T> {
    return this.request<T>("GET", path, undefined, options);
  }

  async post<T>(
    path: string,
    body?: unknown,
    options: SandboxRequestOptions = {},
  ): Promise<T> {
    return this.request<T>("POST", path, body, options);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    options: SandboxRequestOptions = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      ...options.headers,
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    if (options.runId) {
      headers["X-Run-Id"] = options.runId;
    }

    if (options.casePassword) {
      headers["X-Case-Password"] = options.casePassword;
    }

    const response = await fetch(new URL(path, this.baseUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Sandbox ${method} ${path} failed: ${response.status} ${message}`);
    }

    return response.json() as Promise<T>;
  }
}

export const sandboxClient = new SandboxClient();
