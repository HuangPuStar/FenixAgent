import {
  isSandboxCreateRequest,
  rewriteSandboxCreateBody,
  SandboxVolumeRewriteError,
} from "../services/sandbox-volume-rewriter";

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export class OpenSandboxHttpClient {
  constructor(
    // 连接超时（proxyConnectTimeoutMs）暂未接入请求：当前实现只对响应应用
    // AbortSignal.timeout。保留参数以维持配置契约，接入连接超时后恢复使用。
    _connectTimeoutMs: number,
    private readonly responseTimeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(
    baseUrl: string,
    apiKey: string,
    incoming: Request,
    path: string,
    workspaceRoot?: string,
    hostHeader?: string,
  ): Promise<Response> {
    const incomingUrl = new URL(incoming.url);
    const target = new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/$/, "")}/`);
    target.search = incomingUrl.search;
    const headers = new Headers(incoming.headers);
    for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
    headers.delete("authorization");
    headers.delete("open-sandbox-api-key");
    if (hostHeader) headers.set("host", hostHeader);
    headers.set("OPEN-SANDBOX-API-KEY", apiKey);
    const timeout = AbortSignal.timeout(this.responseTimeoutMs);
    let body: RequestInit["body"] = incoming.method === "GET" || incoming.method === "HEAD" ? undefined : incoming.body;
    if (
      workspaceRoot &&
      isSandboxCreateRequest(incoming.method, path) &&
      incoming.headers.get("content-type")?.includes("application/json")
    ) {
      let requestBody: unknown;
      try {
        requestBody = await incoming.clone().json();
      } catch {
        throw new SandboxVolumeRewriteError("sandbox create body must be valid JSON");
      }
      body = JSON.stringify(rewriteSandboxCreateBody(requestBody, workspaceRoot));
      headers.delete("content-length");
    }
    const response = await this.fetchImpl(target, {
      method: incoming.method,
      headers,
      body: body as RequestInit["body"],
      signal: timeout,
      // Bun's fetch accepts streaming request bodies; this is required for exec/file APIs.
      duplex: "half",
    });
    const responseHeaders = new Headers(response.headers);
    for (const header of HOP_BY_HOP_HEADERS) responseHeaders.delete(header);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }
}
