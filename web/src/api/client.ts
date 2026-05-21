/**
 * client.ts — 前端 API 客户端核心
 *
 * 提供:
 * - `api<T>(method, path, body?)` — 类型安全的 POST/GET fetch wrapper
 * - `fetchUpload<T>(path, formData)` — FormData 上传
 * - `createSessionEventSource(sessionId)` — SSE 事件源
 * - Eden Treaty 保留作为 fallback（SSE 等特殊场景）
 */

import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

// ── Eden Treaty (保留用于 SSE 等 fallback) ──

const _client = treaty<App>(typeof globalThis.window !== "undefined" ? globalThis.window.location.origin : "", {
  fetch: { credentials: "include" },
});

// Eden Treaty 降级为 index signature 类型（当 Elysia app 组合的插件过多时 TS 无法解析具体路由键）。
// 此处通过交叉类型补充 web 命名空间，消除 108 个 Property 'web' TS2339 错误。
// biome-ignore lint/suspicious/noExplicitAny: Eden Treaty 降级为 index signature，需要 any 补充 web 命名空间
export const client = _client as typeof _client & { web: any };

// ── 类型安全的 Fetch Wrapper ──

/** 后端统一成功响应格式 */
interface ApiSuccessResponse<T> {
  success: true;
  data: T;
}

/** 后端统一错误响应格式 */
interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

type ApiResponse<T> = ApiSuccessResponse<T> | ApiErrorResponse;

/**
 * 类型安全的 API 调用函数。
 * 替代所有 `client.web.xxx.post(body) + unwrapEden<T>()` 模式。
 *
 * - 自动处理 `{ success, data }` / `{ success, error }` 响应格式
 * - 错误时抛出 `Error`（含 `code` 属性）
 * - 成功时返回 `data` 字段（已解包）
 */
export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const json = (await res.json()) as ApiResponse<T>;

  if (!res.ok || (json && typeof json === "object" && "success" in json && json.success === false)) {
    const errInfo = (json as ApiErrorResponse)?.error ?? { code: "UNKNOWN", message: res.statusText };
    const err = new Error(errInfo.message || errInfo.code) as Error & { code?: string; data?: unknown };
    err.code = errInfo.code;
    throw err;
  }

  // 后端 { success: true, data: T } 包装 → 解包 data
  if (json && typeof json === "object" && "success" in json && json.success === true) {
    return (json as ApiSuccessResponse<T>).data;
  }

  // 非标准格式直接返回
  return json as T;
}

/**
 * 类型安全的 API POST 调用（最常用场景的简写）。
 */
export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return api<T>("POST", path, body);
}

/**
 * 类型安全的 API GET 调用。
 */
export async function apiGet<T>(path: string): Promise<T> {
  return api<T>("GET", path);
}

// ── SSE 辅助函数（Eden 不原生支持 SSE） ──

export function createSessionEventSource(sessionId: string): EventSource {
  const uuid = getUuid();
  const activeOrgId = localStorage.getItem("active_org_id");
  const params = new URLSearchParams();
  if (uuid) params.set("uuid", uuid);
  if (activeOrgId) params.set("activeOrganizationId", activeOrgId);
  const query = params.toString();
  const url = query ? `/web/sessions/${sessionId}/events?${query}` : `/web/sessions/${sessionId}/events`;
  return new EventSource(url, { withCredentials: true });
}

// ── FormData 上传辅助函数 ──

export async function fetchUpload<T>(path: string, formData: FormData): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    credentials: "include",
    body: formData,
  });
  const data = await res.json();
  if (!res.ok) {
    const errInfo = data.error || { type: "unknown", message: res.statusText };
    const err = new Error(errInfo.message || errInfo.type) as Error & { code?: string; data?: unknown };
    if (errInfo && typeof errInfo === "object" && "code" in errInfo) {
      err.code = (errInfo as Record<string, unknown>).code as string;
    }
    if (data.data !== undefined) {
      err.data = data.data;
    }
    throw err;
  }
  return data as T;
}

// ── S3 Presigned URL 上传辅助函数 ──

/** 通过 presigned URL 直传文件到 S3（不经过 RCS 服务器中转） */
export async function uploadToPresignedUrl(url: string, file: File, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`);
}

// ── UUID 存储辅助函数 ──

const UUID_KEY = "rcs_uuid";

export function getUuid(): string {
  return localStorage.getItem(UUID_KEY) || "";
}

export function setUuid(uuid: string): void {
  localStorage.setItem(UUID_KEY, uuid);
}

// ── 组织 API helper ──

type OrgActionBody = Record<string, unknown>;

/**
 * 组织管理 API 统一调用入口。
 */
export async function orgAction<T = unknown>(action: string, params?: OrgActionBody): Promise<T> {
  return apiPost<T>("/web/organizations", { action, ...params });
}
