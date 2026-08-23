import { config } from "../../config";

export type SandboxClusterFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class SandboxClusterAdminError extends Error {
  constructor(
    public readonly status: number,
    message = "Cluster request failed",
  ) {
    super(message);
    this.name = "SandboxClusterAdminError";
  }
}

export class SandboxClusterUnavailableError extends Error {
  constructor() {
    super("Sandbox Cluster service is unavailable");
    this.name = "SandboxClusterUnavailableError";
  }
}

function extractClusterErrorMessage(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    const payload: unknown = JSON.parse(trimmed);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return trimmed;
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "object" && error !== null && !Array.isArray(error)) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) return message;
    }
    if (typeof record.message === "string" && record.message.trim()) return record.message;
  } catch {
    return trimmed;
  }
  return undefined;
}

/** 为主服务管理 API 提供带鉴权的 Cluster JSON 和流式请求。 */
export function createSandboxClusterClient(fetchImpl: SandboxClusterFetch = fetch) {
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!config.openSandboxClusterUrl || !config.openSandboxClusterApiKey) {
      throw new SandboxClusterUnavailableError();
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.sandboxProviderRequestTimeoutMs);
    const signal = init.signal ? combineSignals(controller.signal, init.signal) : controller.signal;
    try {
      const response = await fetchImpl(`${config.openSandboxClusterUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        signal,
        headers: {
          Authorization: `Bearer ${config.openSandboxClusterApiKey}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
          ...init.headers,
        },
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new SandboxClusterAdminError(
          response.status,
          extractClusterErrorMessage(text) ?? `Cluster request failed with status ${response.status}`,
        );
      }
      return response;
    } catch (error) {
      if (error instanceof SandboxClusterAdminError || error instanceof SandboxClusterUnavailableError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new SandboxClusterAdminError(504, "Cluster request timed out");
      }
      throw new SandboxClusterAdminError(503);
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    async json<T>(path: string, init: RequestInit = {}): Promise<T> {
      const response = await request(path, init);
      const text = await response.text();
      if (!text) return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch (error) {
        throw new SandboxClusterAdminError(
          502,
          `Cluster returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    async jsonText(path: string, init: RequestInit = {}): Promise<string> {
      const response = await request(path, init);
      return response.text();
    },
    stream: (path: string, init: RequestInit = {}) => request(path, init),
  };
}

function combineSignals(controllerSignal: AbortSignal, externalSignal: AbortSignal): AbortSignal {
  if (typeof AbortSignal.any === "function") return AbortSignal.any([controllerSignal, externalSignal]);
  const combined = new AbortController();
  const abort = () => combined.abort();
  controllerSignal.addEventListener("abort", abort, { once: true });
  externalSignal.addEventListener("abort", abort, { once: true });
  return combined.signal;
}
