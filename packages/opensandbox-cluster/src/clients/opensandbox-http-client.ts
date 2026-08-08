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
    private readonly connectTimeoutMs: number,
    private readonly responseTimeoutMs: number,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async request(
    baseUrl: string,
    apiKey: string,
    incoming: Request,
    path: string,
    workspaceRoot?: string,
  ): Promise<Response> {
    const incomingUrl = new URL(incoming.url);
    const target = new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/$/, "")}/`);
    target.search = incomingUrl.search;
    const headers = new Headers(incoming.headers);
    for (const header of HOP_BY_HOP_HEADERS) headers.delete(header);
    headers.set("OPEN-SANDBOX-API-KEY", apiKey);
    const timeout = AbortSignal.timeout(this.responseTimeoutMs);
    let body: string | ReadableStream<Uint8Array> | null | undefined =
      incoming.method === "GET" || incoming.method === "HEAD" ? undefined : incoming.body;
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
    return this.fetchImpl(target, {
      method: incoming.method,
      headers,
      body,
      signal: timeout,
      // Bun's fetch accepts streaming request bodies; this is required for exec/file APIs.
      duplex: "half",
    });
  }
}
