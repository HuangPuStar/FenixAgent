/** Agent Sites 远程 API 客户端。封装 master key 鉴权 + 错误处理。 */

import { env } from "../env";

function baseUrl(): string {
  const url = env.AGENT_SITES_BASE_URL;
  if (!url) throw new Error("AGENT_SITES_BASE_URL not configured");
  return url;
}

function masterKey(): string {
  const key = env.AGENT_SITES_MASTER_KEY;
  if (!key) throw new Error("AGENT_SITES_MASTER_KEY not configured");
  return key;
}

const FETCH_TIMEOUT_MS = 30_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const existing = init.signal;
  if (existing) {
    existing.addEventListener("abort", () => ctrl.abort());
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function agentSitesFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${baseUrl()}${path}`;
  const headers = new Headers(init.headers);
  headers.set("X-Master-Key", masterKey());
  if (!headers.has("content-type") && init.method !== "GET" && init.method !== "HEAD") {
    headers.set("content-type", "application/json");
  }
  return fetchWithTimeout(url, { ...init, headers });
}

export class AgentSitesError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "AgentSitesError";
  }
}

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const message = body?.error?.message ?? body?.message ?? res.statusText;
    throw new AgentSitesError(res.status, message);
  }
  return res.json() as Promise<T>;
}

// ── L1 平台管理 API ──────────────────────────────

export interface RemoteApp {
  id: string; // app-xxxxxxxx
  name: string;
  port: number;
  status: string; // starting | running | error
  api_path: string;
  created_at: string;
}

/** POST /api/apps — 创建远程 app */
export async function createRemoteApp(name: string): Promise<RemoteApp> {
  const res = await agentSitesFetch("/api/apps", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
  const json = await handleResponse<{ data: RemoteApp }>(res);
  return json.data;
}

/** DELETE /api/apps/{id} — 删除远程 app */
export async function deleteRemoteApp(remoteAppId: string): Promise<void> {
  const res = await agentSitesFetch(`/api/apps/${encodeURIComponent(remoteAppId)}`, {
    method: "DELETE",
  });
  await handleResponse(res);
}

interface RemoteToken {
  token_id: string;
  app_id: string;
  token: string;
  status: string;
  issued_at: string;
}

/** POST /api/tokens — 申请 platform token */
export async function issuePlatformToken(remoteAppId: string): Promise<RemoteToken> {
  const res = await agentSitesFetch("/api/tokens", {
    method: "POST",
    body: JSON.stringify({ app_id: remoteAppId }),
  });
  const json = await handleResponse<{ data: RemoteToken }>(res);
  return json.data;
}

/** DELETE /api/tokens/{id} — 吊销 platform token */
export async function revokePlatformToken(tokenId: string): Promise<void> {
  const res = await agentSitesFetch(`/api/tokens/${encodeURIComponent(tokenId)}`, {
    method: "DELETE",
  });
  await handleResponse(res);
}

/** PUT /api/apps/{id}/files/{*path} — 上传单个静态文件 */
export async function uploadRemoteFile(
  remoteAppId: string,
  filePath: string,
  body: BodyInit,
): Promise<{ data: { path: string; bytes: number } }> {
  const res = await agentSitesFetch(
    `/api/apps/${encodeURIComponent(remoteAppId)}/files/${encodeURIComponent(filePath)}`,
    { method: "PUT", headers: new Headers(), body },
  );
  return handleResponse(res);
}

/** POST /api/apps/{id}/files/bundle — 批量上传 gzip tar */
export async function uploadRemoteBundle(
  remoteAppId: string,
  body: BodyInit,
): Promise<{ data: { files: { path: string; bytes: number }[] } }> {
  const res = await agentSitesFetch(`/api/apps/${encodeURIComponent(remoteAppId)}/files/bundle`, {
    method: "POST",
    headers: new Headers(),
    body,
  });
  return handleResponse(res);
}

// ── L2/L3 透传 ───────────────────────────────────

/**
 * 透传请求到 agent-sites。不注入 master key——L2 用 platform token，
 * L3 无鉴权或 PB user token。调用方负责设置正确的 headers。
 */
export async function proxyToAgentSites(appId: string, path: string, request: Request): Promise<Response> {
  const targetUrl = `${baseUrl()}/${encodeURIComponent(appId)}${path}`;
  const srcUrl = new URL(request.url);
  const url = new URL(targetUrl);
  srcUrl.searchParams.forEach((v, k) => url.searchParams.set(k, v));

  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("cookie"); // RCS session cookie 不透传

  const init: RequestInit = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }
  try {
    const res = await fetch(url.toString(), init);
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return new Response(null, { status: 499, statusText: "Client Closed Request" });
    }
    return new Response(
      JSON.stringify({
        error: {
          type: "bad_gateway",
          message: `Agent Sites unreachable: ${err instanceof Error ? err.message : String(err)}`,
        },
      }),
      { status: 502, headers: { "Content-Type": "application/json" } },
    );
  }
}

/** 判断 agent-sites 是否已配置 */
export function isAgentSitesConfigured(): boolean {
  return !!env.AGENT_SITES_BASE_URL && !!env.AGENT_SITES_MASTER_KEY;
}
