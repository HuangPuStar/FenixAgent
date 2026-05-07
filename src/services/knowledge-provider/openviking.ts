import { basename } from "node:path";
import { config } from "../../config";
import type {
  KnowledgeBaseSnapshot,
  KnowledgeBaseStatus,
  KnowledgeProvider,
  KnowledgeResourceContent,
  KnowledgeResourceSnapshot,
  KnowledgeResourceStatus,
  KnowledgeSearchResult,
} from "./types";

const RESOURCE_STATUS_READY: KnowledgeResourceStatus = "ready";

type SupportedHeadersInit = Headers | Record<string, string> | string[][];

function buildHeaders(
  extra?: SupportedHeadersInit,
  identity?: { account?: string | null; user?: string | null },
): Headers {
  const headers = new Headers(extra);
  headers.set("Accept", "application/json");
  if (config.knowledgeApiKey) {
    headers.set("X-API-Key", config.knowledgeApiKey);
    headers.set("Authorization", `Bearer ${config.knowledgeApiKey}`);
  }
  if (identity?.account) {
    headers.set("X-OpenViking-Account", identity.account);
  }
  if (identity?.user) {
    headers.set("X-OpenViking-User", identity.user);
  }
  return headers;
}

function inferTitleFromUri(uri: string): string {
  const trimmed = uri.replace(/\/+$/, "");
  const lastSegment = trimmed.split("/").pop() || trimmed;
  return lastSegment || "Untitled";
}

function inferKnowledgeBaseRemoteId(resourceRemoteId: string): string | null {
  const trimmed = resourceRemoteId.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.endsWith("/")) {
    return trimmed;
  }
  const separatorIndex = trimmed.lastIndexOf("/");
  if (separatorIndex < "viking://".length) {
    return null;
  }
  return `${trimmed.slice(0, separatorIndex + 1)}`;
}

function inferSnippet(item: Record<string, unknown>): string {
  for (const key of ["snippet", "content", "text", "overview", "abstract", "summary"]) {
    if (typeof item[key] === "string" && item[key].trim().length > 0) {
      return item[key] as string;
    }
  }
  return "";
}

function normalizeSearchItems(
  result: Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>>; resources?: Array<Record<string, unknown>> },
): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result;
  }
  if (Array.isArray(result.resources)) {
    return result.resources;
  }
  return result.items ?? [];
}

function extractResult<T>(payload: T | { result?: T }): T {
  if (payload && typeof payload === "object" && "result" in (payload as Record<string, unknown>)) {
    return ((payload as { result?: T }).result ?? null) as T;
  }
  return payload as T;
}

async function requestJson<T>(
  path: string,
  init?: RequestInit,
  identity?: { account?: string | null; user?: string | null },
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.knowledgeRequestTimeoutMs);
  try {
    const response = await fetch(`${config.knowledgeBaseUrl}${path}`, {
      ...init,
      headers: buildHeaders(init?.headers as SupportedHeadersInit | undefined, identity),
      signal: controller.signal,
    });
    const contentType = response.headers.get("content-type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json()
      : await response.text();
    if (!response.ok) {
      throw normalizeProviderError(payload, response.status);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error("OpenViking request failed");
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeProviderError(payload: unknown, status?: number): Error {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const message =
      (typeof record.message === "string" && record.message) ||
      (record.error && typeof record.error === "object" && typeof (record.error as Record<string, unknown>).message === "string"
        ? ((record.error as Record<string, unknown>).message as string)
        : "");
    if (message) {
      return new Error(message);
    }
  }
  if (typeof payload === "string" && payload.trim()) {
    return new Error(payload);
  }
  return new Error(status ? `OpenViking request failed (${status})` : "OpenViking request failed");
}

function normalizeStatus(value: unknown, kind: "knowledgeBase"): KnowledgeBaseStatus;
function normalizeStatus(value: unknown, kind: "resource"): KnowledgeResourceStatus;
function normalizeStatus(
  value: unknown,
  kind: "knowledgeBase" | "resource",
): KnowledgeBaseStatus | KnowledgeResourceStatus {
  const normalized = String(value || "").toLowerCase();
  if (kind === "knowledgeBase") {
    if (["ready", "active", "completed", "success"].includes(normalized)) return "ready";
    if (["indexing", "processing", "running", "pending"].includes(normalized)) return "indexing";
    if (["error", "failed"].includes(normalized)) return "error";
    return "empty";
  }
  if (["ready", "completed", "success"].includes(normalized)) return "ready";
  if (["processing", "indexing", "running"].includes(normalized)) return "processing";
  if (["error", "failed"].includes(normalized)) return "error";
  return "pending";
}

export class OpenVikingKnowledgeProvider implements KnowledgeProvider {
  async createKnowledgeBase(input: {
    userId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<KnowledgeBaseSnapshot> {
    return {
      remoteId: null,
      name: input.name,
      description: input.description ?? null,
      status: "empty",
      lastError: null,
    };
  }

  async addResource(input: {
    knowledgeBaseRemoteId?: string | null;
    targetRemoteId?: string | null;
    remoteAccountId: string;
    remoteUserId: string;
    filePath?: string;
    url?: string;
    sourceName?: string;
    wait?: boolean;
  }): Promise<KnowledgeResourceSnapshot> {
    const identity = {
      account: input.remoteAccountId,
      user: input.remoteUserId,
    };
    let tempFileId: string | null = null;
    if (input.filePath) {
      const file = Bun.file(input.filePath);
      const formData = new FormData();
      formData.append("file", file, basename(input.filePath));
      const uploadPayload = await requestJson<Record<string, unknown> | { result?: Record<string, unknown> }>(
        "/api/v1/resources/temp_upload",
        {
          method: "POST",
          body: formData,
        },
        identity,
      );
      const uploadResult = extractResult<Record<string, unknown>>(uploadPayload);
      tempFileId = String(uploadResult.temp_file_id ?? uploadResult.tempFileId ?? "");
      if (!tempFileId) {
        throw new Error("OpenViking temp_upload did not return temp_file_id");
      }
    }

    const payload = await requestJson<Record<string, unknown> | { result?: Record<string, unknown> }>(
      "/api/v1/resources",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(input.url ? { path: input.url } : {}),
          ...(tempFileId ? { temp_file_id: tempFileId } : {}),
          ...(input.targetRemoteId ? { to: input.targetRemoteId } : {}),
          ...(!input.targetRemoteId && input.knowledgeBaseRemoteId ? { parent: input.knowledgeBaseRemoteId } : {}),
          reason: input.sourceName ?? "",
          wait: input.wait ?? false,
        }),
      },
      identity,
    );
    const result = extractResult<Record<string, unknown>>(payload);
    const remoteId = String(result.root_uri ?? result.rootUri ?? result.uri ?? "");
    return {
      remoteId,
      knowledgeBaseRemoteId:
        (typeof result.parent_uri === "string" && result.parent_uri) ||
        (typeof result.parentUri === "string" && result.parentUri) ||
        (typeof result.target_uri === "string" && result.target_uri) ||
        (typeof result.targetUri === "string" && result.targetUri) ||
        inferKnowledgeBaseRemoteId(remoteId),
      sourceName: String(result.sourceName ?? input.sourceName ?? input.url ?? input.filePath ?? "resource"),
      sourceType: String(result.sourceType ?? (input.url ? "url" : "upload")),
      source: typeof result.source_path === "string" ? result.source_path : input.url ?? input.filePath ?? null,
      status: normalizeStatus(result.status ?? "processing", "resource"),
      lastError: Array.isArray(result.errors) && result.errors.length > 0 ? String(result.errors[0]) : null,
    };
  }

  async listResources(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<KnowledgeResourceSnapshot[]> {
    const identity = {
      account: input.remoteAccountId,
      user: input.remoteUserId,
    };
    const payload = await requestJson<
      Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>> } | { result?: Array<Record<string, unknown>> }
    >(
      `/api/v1/fs/ls?uri=${encodeURIComponent(input.knowledgeBaseRemoteId)}&recursive=true`,
      undefined,
      identity,
    );
    const result = extractResult<Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>> }>(payload);
    const items = Array.isArray(result) ? result : result.items ?? [];
    return items.map((item) => ({
      remoteId: String(item.uri ?? item.remoteId ?? item.id ?? ""),
      sourceName: String(item.name ?? item.sourceName ?? inferTitleFromUri(String(item.uri ?? "resource"))),
      sourceType: item.isDir ? "directory" : "resource",
      source: typeof item.uri === "string" ? item.uri : null,
      status: RESOURCE_STATUS_READY,
      lastError: null,
    })).filter((item) => item.remoteId.length > 0);
  }

  async deleteResource(input: {
    resourceRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    recursive?: boolean;
  }): Promise<void> {
    const identity = {
      account: input.remoteAccountId,
      user: input.remoteUserId,
    };
    const query = new URLSearchParams({
      uri: input.resourceRemoteId,
      recursive: input.recursive ? "true" : "false",
    });
    await requestJson(
      `/api/v1/fs?${query.toString()}`,
      {
        method: "DELETE",
      },
      identity,
    );
  }

  async search(input: {
    knowledgeBases: Array<{
      remoteId: string;
      remoteAccountId: string;
      remoteUserId: string;
    }>;
    query: string;
    topK: number;
  }): Promise<KnowledgeSearchResult[]> {
    const nestedResults = await Promise.all(input.knowledgeBases.map(async (knowledgeBase) => {
      const targetUri = knowledgeBase.remoteId;
      const identity = {
        account: knowledgeBase.remoteAccountId,
        user: knowledgeBase.remoteUserId,
      };
      const payload = await requestJson<
        | Array<Record<string, unknown>>
        | { items?: Array<Record<string, unknown>>; resources?: Array<Record<string, unknown>> }
        | { result?: Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>>; resources?: Array<Record<string, unknown>> } }
      >(
        "/api/v1/search/search",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            query: input.query,
            limit: input.topK,
            target_uri: targetUri,
          }),
        },
        identity,
      );
      const result = extractResult<
        Array<Record<string, unknown>> | { items?: Array<Record<string, unknown>>; resources?: Array<Record<string, unknown>> }
      >(payload);
      const items = normalizeSearchItems(result);
      return items.map((item) => ({
        title: String(item.title ?? item.name ?? inferTitleFromUri(String(item.uri ?? targetUri))),
        snippet: inferSnippet(item),
        source: String(item.source ?? item.uri ?? targetUri),
        score: Number(item.score ?? item.distance ?? 0),
        knowledgeBaseId: targetUri,
        resourceId: item.resourceId ? String(item.resourceId) : (item.uri ? String(item.uri) : null),
      }));
    }));

    return nestedResults
      .flat()
      .sort((a, b) => b.score - a.score)
      .slice(0, input.topK);
  }

  async readResource(input: {
    resourceRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<KnowledgeResourceContent> {
    const identity = {
      account: input.remoteAccountId,
      user: input.remoteUserId,
    };
    const payload = await requestJson<string | Record<string, unknown> | { result?: string | Record<string, unknown> }>(
      `/api/v1/content/read?uri=${encodeURIComponent(input.resourceRemoteId)}`,
      undefined,
      identity,
    );
    const result = extractResult<string | Record<string, unknown>>(payload);
    return {
      resourceId: input.resourceRemoteId,
      title: inferTitleFromUri(input.resourceRemoteId),
      content: typeof result === "string" ? result : String(result.content ?? result.result ?? ""),
      source: input.resourceRemoteId,
    };
  }
}

export function createKnowledgeProvider(): KnowledgeProvider {
  return new OpenVikingKnowledgeProvider();
}
