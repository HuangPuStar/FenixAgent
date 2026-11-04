import { afterEach, describe, expect, test } from "bun:test";
import { AppError } from "@fenix/platform-sdk";
import { readJson, resetAllStubs, stubAuthApi } from "@fenix/platform-sdk/testing";
import Elysia from "elysia";
import * as z from "zod/v4";
import { authGuardPlugin, resetTestAuth } from "../plugins/auth";
import { bodyLimitPlugin, MAX_REQUEST_BODY_BYTES } from "../plugins/body-limit";
import { errorPlugin } from "../plugins/error-handler";
import { createApiApp } from "../routes/api";

const app = new Elysia()
  .use(errorPlugin)
  .use(bodyLimitPlugin)
  .use(authGuardPlugin)
  .get("/api/v1/providers", () => [], { sessionAuth: true })
  .post("/api/v1/check", ({ body }) => body, { body: z.object({ count: z.number() }).strict() })
  .get("/api/v1/fault", () => {
    throw new Error("secret-internal-path");
  })
  .get("/api/v1/conflict", () => {
    throw new AppError("Conflict", "CONFLICT", 409);
  })
  .post("/api/v1/chat/completions", () => {
    throw new AppError("Busy", "AGENT_SESSION_BUSY", 409);
  })
  .get("/api/system/check", () => {
    throw new AppError("Denied", "FORBIDDEN", 403);
  });

const send = (path: string, init?: RequestInit) => app.handle(new Request(`http://localhost${path}`, init));
afterEach(() => {
  resetTestAuth();
  resetAllStubs();
});

describe("External v1 host protocol", () => {
  // 无 Content-Length 的实际流式请求也受总预算约束，不能只防伪造长度头。
  test("无长度流式 JSON 请求超过传输预算返回 v1 413", async () => {
    const host = new Elysia()
      .use(errorPlugin)
      .use(bodyLimitPlugin)
      .post("/api/v1/body", ({ body }) => body, { parse: "json" })
      .listen({ port: 0, hostname: "127.0.0.1", maxRequestBodySize: Number.MAX_SAFE_INTEGER });
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_REQUEST_BODY_BYTES) {
          controller.close();
          return;
        }
        const chunk = new Uint8Array(1024 * 1024);
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${host.server!.port}/api/v1/body`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(response.status).toBe(413);
      const parsed = await readJson(response);
      expect(parsed.success).toBe(false);
      expect(parsed.error.code).toBe("PAYLOAD_TOO_LARGE");
    } finally {
      await host.stop(true);
    }
  });
  // 生产站点代理注册全局通配兜底，未知 API 仍需命中版本化错误响应。
  test("未知 v1 路径优先于最终全局通配兜底", async () => {
    const host = new Elysia()
      .use(errorPlugin)
      .use(createApiApp({ api: [] }))
      .all("/*", ({ set }) => {
        set.status = 404;
        return "Not Found";
      });
    const response = await host.handle(new Request("http://localhost/api/v1/missing"));
    expect(response.status).toBe(404);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Resource not found" },
    });
  });
  // 宿主提前拒绝大请求时也按入口协议返回 413，不必实际分配大请求体。
  test("传输上限按 v1、Chat 和 system 返回各自的错误格式", async () => {
    for (const path of ["/api/v1/check", "/api/v1/chat/completions", "/api/system/check"]) {
      const response = await send(path, {
        method: path.includes("system") ? "GET" : "POST",
        headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) },
      });
      expect(response.status).toBe(413);
      const body = await readJson(response);
      if (path === "/api/v1/check") {
        expect(body.success).toBe(false);
        expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
      } else if (path.includes("chat")) {
        expect(body.success).toBeUndefined();
        expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
        expect(body.error.param).toBeNull();
      } else expect(body.error.type).toBe("PAYLOAD_TOO_LARGE");
    }
  });
  // 守卫提前拒绝也必须满足普通 v1 的错误协议。
  test("未认证返回 v1 401", async () => {
    resetTestAuth();
    stubAuthApi({ getSession: async () => null });
    const response = await send("/api/v1/providers");
    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({
      success: false,
      error: { code: "UNAUTHORIZED", message: "Not authenticated" },
    });
  });
  // 未知路径和异常不应绕过版本包装或泄漏内部信息。
  test("404、业务冲突和未知异常统一包装", async () => {
    for (const [path, status, code] of [
      ["missing", 404, "NOT_FOUND"],
      ["conflict", 409, "CONFLICT"],
      ["fault", 500, "INTERNAL_ERROR"],
    ] as const) {
      const response = await send(`/api/v1/${path}`);
      expect(response.status).toBe(status);
      const body = await readJson(response);
      expect(body.success).toBe(false);
      expect(body.error.code).toBe(code);
      expect(JSON.stringify(body)).not.toContain("secret-internal-path");
    }
  });
  // 参数错误不能把框架校验详情当成业务数据响应。
  test("严格参数错误返回 400 包装", async () => {
    const response = await send("/api/v1/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"count":"bad"}',
    });
    expect(response.status).toBe(400);
    expect((await readJson(response)).success).toBe(false);
  });
  // Chat 原生错误与 system 的既有协议各自独立。
  test("Chat 保持 SDK 原生，system 保持旧格式", async () => {
    const chat = await send("/api/v1/chat/completions", { method: "POST" });
    expect(chat.status).toBe(409);
    expect(await readJson(chat)).toEqual({
      error: { message: "Busy", type: "invalid_request_error", param: null, code: "AGENT_SESSION_BUSY" },
    });
    expect(await readJson(await send("/api/system/check"))).toEqual({
      error: { type: "FORBIDDEN", message: "Denied" },
    });
  });
});
