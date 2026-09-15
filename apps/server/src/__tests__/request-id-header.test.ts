import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import { AppError } from "../errors";
import { errorPlugin } from "../plugins/error-handler";
import { deriveRequestId, injectRequestId, isRecoverableCtrlSpa404, logError } from "../plugins/logger";

describe("X-Request-Id response header", () => {
  const app = new Elysia()
    .derive(deriveRequestId)
    .onAfterHandle(injectRequestId)
    .onError(({ request, error, set }) => logError({ request, error, set }))
    .use(errorPlugin)
    .get("/ok", () => ({ success: true }))
    .get("/boom", () => {
      throw new AppError("boom", "INTERNAL_ERROR", 500);
    });

  // 成功响应应返回 X-Request-Id，方便和日志里的 requestId 对齐。
  test("成功响应包含 X-Request-Id", async () => {
    const response = await app.handle(new Request("http://localhost/ok"));

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Request-Id")).toBeString();
  });

  // 错误响应也应返回 X-Request-Id，避免排障时只能依赖 body 或服务端日志。
  test("错误响应包含 X-Request-Id", async () => {
    const response = await app.handle(new Request("http://localhost/boom"));

    expect(response.status).toBe(500);
    expect(response.headers.get("X-Request-Id")).toBeString();
  });
});

describe("isRecoverableCtrlSpa404", () => {
  test("识别 /ctrl 下无扩展名的前端深链 404", () => {
    const request = new Request("http://localhost/ctrl/agent/mcp");
    const error = Object.assign(new Error("NOT_FOUND"), { name: "NotFoundError", status: 404, code: "NOT_FOUND" });

    expect(isRecoverableCtrlSpa404(request, error, 404)).toBe(true);
  });

  test("静态资源缺失不应视为 SPA fallback", () => {
    const request = new Request("http://localhost/ctrl/assets/main.js");
    const error = Object.assign(new Error("NOT_FOUND"), { name: "NotFoundError", status: 404, code: "NOT_FOUND" });

    expect(isRecoverableCtrlSpa404(request, error, 404)).toBe(false);
  });

  test("非 /ctrl 路径不应忽略 404", () => {
    const request = new Request("http://localhost/api/mcp");
    const error = Object.assign(new Error("NOT_FOUND"), { name: "NotFoundError", status: 404, code: "NOT_FOUND" });

    expect(isRecoverableCtrlSpa404(request, error, 404)).toBe(false);
  });
});
