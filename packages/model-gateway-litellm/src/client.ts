import { ModelGatewayError } from "@fenix/model-gateway-sdk";

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface LiteLlmClientOptions {
  baseUrl: string;
  adminKey: string;
  timeoutMs: number;
  fetchImpl?: FetchImpl;
}

interface LiteLlmClient {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
}

function mapHttpError(status: number, requestId: string | null): ModelGatewayError {
  const context = requestId ? ` (request id: ${requestId})` : "";
  if (status === 401 || status === 403) {
    return new ModelGatewayError("UNAUTHORIZED", `LiteLLM request unauthorized${context}`);
  }
  if (status === 404) {
    return new ModelGatewayError("NOT_FOUND", `LiteLLM resource not found${context}`);
  }
  if (status === 409) {
    return new ModelGatewayError("CONFLICT", `LiteLLM request conflicted${context}`);
  }
  if (status === 429) {
    return new ModelGatewayError("RATE_LIMITED", `LiteLLM request was rate limited${context}`);
  }
  if (status >= 500) {
    return new ModelGatewayError("UNAVAILABLE", `LiteLLM service unavailable${context}`);
  }
  return new ModelGatewayError("INVALID_RESPONSE", `LiteLLM returned HTTP ${status}${context}`);
}

function readApplicationErrorStatus(value: unknown): number | null {
  if (!value || typeof value !== "object" || !("error" in value)) return null;
  const error = value.error;
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  const status = Number(error.code);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : null;
}

export function createLiteLlmClient(options: LiteLlmClientOptions): LiteLlmClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  const fetchImpl: FetchImpl = options.fetchImpl ?? fetch;

  return {
    async get<T>(path: string): Promise<T> {
      return request<T>("GET", path);
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      return request<T>("POST", path, body);
    },
  };

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

    try {
      let response: Response;
      try {
        response = await fetchImpl(`${baseUrl}${path}`, {
          method,
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${options.adminKey}`,
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          },
          signal: controller.signal,
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new ModelGatewayError("UNAVAILABLE", "LiteLLM request timed out", { cause: error });
        }
        throw new ModelGatewayError("UNAVAILABLE", "LiteLLM request failed", { cause: error });
      }

      if (!response.ok) {
        throw mapHttpError(response.status, response.headers.get("x-request-id"));
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        throw new ModelGatewayError("INVALID_RESPONSE", "LiteLLM returned invalid JSON", { cause: error });
      }
      const applicationErrorStatus = readApplicationErrorStatus(payload);
      if (applicationErrorStatus !== null) {
        throw mapHttpError(applicationErrorStatus, response.headers.get("x-request-id"));
      }
      return payload as T;
    } finally {
      clearTimeout(timeout);
    }
  }
}
