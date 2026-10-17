import { describe, expect, test } from "bun:test";
import { status } from "elysia";
import { resolveResponseStatus } from "../plugins/logger";

describe("请求结束日志的状态码解析", () => {
  // Elysia 在 onAfterHandle 阶段还没把 status(code, body) 容器映射到 set.status（默认仍是 200），
  // 日志必须取容器上的真实状态，否则 BFF 的 401 ticket_invalid 会被记成 200、与浏览器 Network 对不上。
  test("自定义状态容器优先于默认的 set.status", () => {
    expect(resolveResponseStatus(200, status(401, { code: 401, msg: "ticket_invalid" }))).toBe(401);
  });

  // 处理器直接返回 Response 时，实际 HTTP 状态在 Response 上，set.status 仍是默认 200。
  test("Response 优先于默认的 set.status", () => {
    expect(resolveResponseStatus(200, new Response(null, { status: 404 }))).toBe(404);
  });

  // 显式 set.status 的普通响应不受上述分支影响。
  test("普通响应沿用显式 set.status", () => {
    expect(resolveResponseStatus(204, { ok: true })).toBe(204);
  });
});
