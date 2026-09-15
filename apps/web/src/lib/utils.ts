import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { v4 as uuidv4 } from "uuid";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function esc(str: string | null | undefined): string {
  if (!str) return "";
  const value = String(str);
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

export function formatTime(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleString();
}

export function statusClass(status: string | null | undefined): string {
  const map: Record<string, string> = {
    active: "active",
    running: "running",
    idle: "idle",
    inactive: "inactive",
    requires_action: "requires_action",
    archived: "archived",
    error: "error",
  };
  return map[status || ""] || "default";
}

export function isClosedSessionStatus(status: string | null | undefined): boolean {
  return status === "archived" || status === "inactive";
}

export function truncate(str: string | null | undefined, max: number): string {
  if (!str) return "";
  const s = String(str);
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

export function generateMessageUuid(): string {
  return uuidv4();
}

/**
 * 生成浏览器安全的 UUID v4。
 * 原生 crypto.randomUUID 仅在 secure context（HTTPS / localhost）下可用，纯 HTTP 部署
 * 时其为 undefined，直接调用会抛 TypeError。全局场景由 random-uuid-polyfill 在
 * bootstrap 阶段注入降级实现（见 web/src/lib/random-uuid-polyfill.ts）；此处保留
 * 独立降级路径作为纵深防御（polyfill 注入失败或绕过 bootstrap 的调用场景），
 * 保证 HTTP / HTTPS 环境下均可生成随机 ID。
 */
export function randomUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return uuidv4();
}

export function extractEventText(payload: Record<string, unknown> | null | undefined): string {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.content === "string") return payload.content;
  const msg = payload.message as Record<string, unknown> | undefined;
  if (msg && typeof msg === "object" && Array.isArray(msg.content)) {
    const texts = msg.content
      .filter((b: Record<string, unknown>) => b && b.type === "text" && typeof b.text === "string")
      .map((b: Record<string, unknown>) => b.text as string);
    if (texts.length > 0) return texts.join("\n");
  }
  return "";
}

export function isConversationClearedStatus(payload: Record<string, unknown> | null | undefined): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (payload.status === "conversation_cleared") return true;
  const raw = payload.raw as Record<string, unknown> | undefined;
  return !!raw && typeof raw === "object" && raw.status === "conversation_cleared";
}
