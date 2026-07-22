import { describe, expect, test } from "bun:test";
import Elysia from "elysia";
import { AppError } from "../errors";
import { errorPlugin } from "../plugins/error-handler";
import { deriveRequestId, injectRequestId, logError } from "../plugins/logger";

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
