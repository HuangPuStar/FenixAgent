import { SandboxProviderError } from "./provider";

export type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** Cluster 管理和 proxy 请求共用的最小 HTTP 客户端。 */
export class ClusterHttpClient {
  constructor(private readonly fetchImpl: FetchImpl = fetch) {}

  async json<T>(baseUrl: string, apiKey: string, path: string, timeoutMs: number, init: RequestInit = {}): Promise<T> {
    const url = `${baseUrl.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${apiKey}`);
    if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new SandboxProviderError(
        `sandbox provider request failed: ${error instanceof Error ? error.message : String(error)}`,
        "UNAVAILABLE",
        true,
        error,
      );
    }

    if (!response.ok) {
      const message = await response.text().catch(() => "");
      const code =
        response.status === 401 || response.status === 403
          ? "INVALID_REQUEST"
          : response.status === 404
            ? "NOT_FOUND"
            : response.status >= 500
              ? "UNAVAILABLE"
              : "REMOTE_ERROR";
      throw new SandboxProviderError(
        `sandbox provider request failed with HTTP ${response.status}${message ? `: ${message.slice(0, 200)}` : ""}`,
        code,
        response.status >= 500,
        undefined,
        response.status,
      );
    }

    if (response.status === 204) return undefined as T;
    try {
      return (await response.json()) as T;
    } catch (error) {
      throw new SandboxProviderError("sandbox provider returned invalid JSON", "REMOTE_ERROR", false, error);
    }
  }
}
