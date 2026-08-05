import Elysia from "elysia";
import type { RateLimitEntry } from "../types/store";

const store = new Map<string, RateLimitEntry>();

const WINDOW_MS = 60_000; // 1 分钟窗口
const MAX_REQUESTS = 100; // 每窗口最大请求数

function getClientId(request: Request, server?: unknown): string {
  // 优先真实连接 IP（Bun server.requestIP）：本地开发/直连场景请求无
  // x-forwarded-for/x-real-ip 头，此前 fallback "unknown" 会让所有客户端
  // （多标签页/多用户/静态资源）共享一个限流桶，页面加载 + 轮询 + 频繁
  // 操作很快耗尽 100 req/min 配额，误触 429 "Too many requests"
  const socket = (server as { requestIP?: (req: Request) => { address: string } | null } | undefined)?.requestIP?.(
    request,
  );
  if (socket?.address) return socket.address;
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

// 必须显式 `{ as: "global" }`：Elysia 的 use() 只合并 scope 为 global/scoped 的
// hook，onBeforeHandle 默认 scope 是 local，缺省时限流对主 app 路由从未生效
// （2026-08 修复 errorPlugin 同类问题时经实验确认 105 连发全部放行）。
export const rateLimitPlugin = new Elysia({ name: "rate-limit" }).onBeforeHandle(
  { as: "global" },
  ({ request, server }) => {
    // 测试环境跳过限流
    if (process.env.NODE_ENV === "test" || (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST)) {
      return;
    }

    // 静态资源（/ctrl/*，前端页面/脚本/样式）不消耗 API 配额：单次页面加载
    // 产生几十个资源请求，计入限流会让正常浏览误触 429
    const pathname = new URL(request.url).pathname;
    if (pathname === "/ctrl" || pathname.startsWith("/ctrl/")) {
      return;
    }

    const clientId = getClientId(request, server);
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
  },
);

// 定期清理过期条目（每 5 分钟）
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (now > entry.resetAt) store.delete(key);
  }
}, 5 * 60_000);
