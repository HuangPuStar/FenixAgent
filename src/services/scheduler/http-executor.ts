import type { TaskExecInput, TaskExecOutput, TaskExecutor } from "./types";

interface HttpDefinition {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function parseDefinition(raw: unknown): HttpDefinition {
  const def = raw as HttpDefinition;
  return { url: String(def.url ?? ""), method: def.method, headers: def.headers, body: def.body };
}

export const httpExecutor: TaskExecutor = {
  type: "http",

  async execute(input: TaskExecInput): Promise<TaskExecOutput> {
    const { task } = input;
    const def = parseDefinition(task.definition);
    const method = (def.method ?? "POST").toUpperCase();
    const startTime = Date.now();

    const headers: Record<string, string> = { ...(def.headers ?? {}) };
    const hasContentType = Object.keys(headers).some((k) => k.toLowerCase() === "content-type");
    if (!hasContentType && method !== "GET") {
      headers["Content-Type"] = "application/json";
    }

    const timeoutMs = (task.timeoutSeconds ?? 30) * 1000;
    const response = await fetch(def.url, {
      method,
      headers,
      body: method === "GET" ? undefined : (def.body ?? undefined),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const responseText = await response.text().catch(() => "");
    const duration = Date.now() - startTime;
    const status = response.ok ? "success" : "failed";
    const resultSummary =
      responseText.length > 2000 ? responseText.slice(0, 2000) : responseText || `HTTP ${response.status}`;

    if (response.ok) {
      return { status, duration, resultSummary };
    }
    return {
      status,
      duration,
      resultSummary,
      error: responseText ? `HTTP ${response.status}: ${responseText.slice(0, 500)}` : `HTTP ${response.status}`,
    };
  },
};
