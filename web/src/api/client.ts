import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

const _client = treaty<App>(typeof globalThis.window !== "undefined" ? globalThis.window.location.origin : "", {
  fetch: { credentials: "include" },
});

// Eden Treaty 降级为 index signature 类型（当 Elysia app 组合的插件过多时 TS 无法解析具体路由键）。
// 此处通过交叉类型补充 web 命名空间，消除 108 个 Property 'web' TS2339 错误。
// 待 Eden Treaty 支持复杂插件组合的类型推断后可移除此断言。
// biome-ignore lint/suspicious/noExplicitAny: Eden Treaty 降级为 index signature，需要 any 补充 web 命名空间
export const client = _client as typeof _client & { web: any };

// --- Eden 响应解包辅助 ---

/**
 * 从 Eden Treaty 响应中解包数据。
 * 处理 { success, data } 格式的后端响应，以及 Eden 的 { data, error } 结构。
 * 统一错误抛出逻辑，消除各处重复的 fetch + JSON parse + error 检查。
 * 参数类型为 unknown 而非 EdenResponse，因为 client.web 被降级为 any，
 * 回调中拿到的值也是 unknown/any，需要用运行时检查来解包。
 */
// biome-ignore lint/suspicious/noExplicitAny: Eden client.web 是 any，这里也需要 any 来访问属性
export function unwrapEden<T>(res: any): T {
  if (res?.error) {
    const errInfo = res.error.value ?? res.error;
    throw new Error(errInfo?.message ?? errInfo?.type ?? "Request failed");
  }
  const raw = res?.data;
  // 后端 { success, data } 包装
  if (raw && typeof raw === "object" && raw.success === true) {
    return raw.data as T;
  }
  return raw as T;
}

// --- SSE 辅助函数（Eden 不原生支持 SSE） ---

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

// --- FormData 上传辅助函数 ---

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

// --- S3 Presigned URL 上传辅助函数 ---

/** 通过 presigned URL 直传文件到 S3（不经过 RCS 服务器中转） */
export async function uploadToPresignedUrl(url: string, file: File, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": contentType },
  });
  if (!res.ok) throw new Error(`S3 upload failed: ${res.status}`);
}

// --- UUID 存储辅助函数 ---

const UUID_KEY = "rcs_uuid";

export function getUuid(): string {
  return localStorage.getItem(UUID_KEY) || "";
}

export function setUuid(uuid: string): void {
  localStorage.setItem(UUID_KEY, uuid);
}
