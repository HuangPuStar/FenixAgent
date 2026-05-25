import Elysia from "elysia";
import type { RateLimitEntry } from "../types/store";

const store = new Map<string, RateLimitEntry>();

const WINDOW_MS = 60_000; // 1 分钟窗口
const MAX_REQUESTS = 100; // 每窗口最大请求数

function getClientId(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

export const rateLimitPlugin = new Elysia({ name: "rate-limit" }).onBeforeHandle(({ request }) => {
  // 测试环境跳过限流
  if (process.env.NODE_ENV === "test" || (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST)) {
    return;
  }

  const clientId = getClientId(request);
  const now = Date.now();
  let entry = store.get(clientId);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    store.set(clientId, entry);
  }

  entry.count++;

  if (entry.count > MAX_REQUESTS) {
    return new Response(JSON.stringify({ error: { type: "RATE_LIMITED", message: "Too many requests" } }), {
      status: 429,
      headers: { "Content-Type": "application/json", "Retry-After": "60" },
    });
  }
});

// 定期清理过期条目（每 5 分钟）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 5 * 60_000);
