import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

export const client = treaty<App>(
  typeof globalThis.window !== "undefined" ? globalThis.window.location.origin : "",
  { fetch: { credentials: "include" } },
);

// --- SSE 辅助函数（Eden 不原生支持 SSE） ---

export function createSessionEventSource(sessionId: string): EventSource {
  return new EventSource(`/web/sessions/${sessionId}/events`, { withCredentials: true });
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

// --- UUID 存储辅助函数 ---

const UUID_KEY = "rcs_uuid";

export function getUuid(): string {
  return localStorage.getItem(UUID_KEY) || "";
}

export function setUuid(uuid: string): void {
  localStorage.setItem(UUID_KEY, uuid);
}
