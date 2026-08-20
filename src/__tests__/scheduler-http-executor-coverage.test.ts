import { afterEach, describe, expect, mock, test } from "bun:test";
import type { ScheduledTaskV2Row } from "../db/schema";
import { httpExecutor } from "../services/scheduler/http-executor";

const originalFetch = globalThis.fetch;

function mockFetch(handler: () => Promise<Response>) {
  return mock(async (_input: string | URL | Request, _init?: RequestInit) => handler());
}

function installFetch(fetchMock: ReturnType<typeof mockFetch>) {
  globalThis.fetch = Object.assign(fetchMock, { preconnect: originalFetch.preconnect });
}

function task(definition: unknown, timeoutSeconds = 1): ScheduledTaskV2Row {
  return {
    id: "task-http",
    userId: "user-1",
    organizationId: "org-1",
    name: "http",
    description: null,
    cron: "* * * * *",
    timezone: null,
    enabled: true,
    timeoutSeconds,
    type: "http",
    agentId: null,
    definition,
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("http-executor 请求、错误与取消", () => {
  // 默认 POST 请求应自动补齐 JSON Content-Type 并传递请求体。
  test("默认 POST 补齐 JSON 请求头", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("ok", { status: 200 })));
    installFetch(fetchMock);
    const result = await httpExecutor.execute({
      task: task({ url: "https://example.test", body: '{"a":1}' }),
      triggeredBy: "manual",
    });
    expect(result).toEqual(expect.objectContaining({ status: "success", resultSummary: "ok" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test",
      expect.objectContaining({ method: "POST", body: '{"a":1}', headers: { "Content-Type": "application/json" } }),
    );
  });

  // GET 请求不得附带 body 或默认 Content-Type。
  test("GET 请求不发送 body", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("", { status: 204 })));
    installFetch(fetchMock);
    const result = await httpExecutor.execute({
      task: task({ url: "https://example.test", method: "get", body: "ignored" }),
      triggeredBy: "cron",
    });
    expect(result.status).toBe("success");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test",
      expect.objectContaining({ method: "GET", body: undefined, headers: {} }),
    );
  });

  // 调用方指定 Content-Type 时不得被覆盖。
  test("保留调用方指定的 Content-Type", async () => {
    const fetchMock = mockFetch(() => Promise.resolve(new Response("ok")));
    installFetch(fetchMock);
    await httpExecutor.execute({
      task: task({ url: "https://example.test", headers: { "content-type": "text/plain" } }),
      triggeredBy: "manual",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://example.test",
      expect.objectContaining({ headers: { "content-type": "text/plain" } }),
    );
  });

  // 非 2xx 响应必须返回 failed 和有限长度的 HTTP 错误摘要。
  test("非成功状态返回 HTTP 错误", async () => {
    installFetch(mockFetch(() => Promise.resolve(new Response("denied", { status: 403 }))));
    const result = await httpExecutor.execute({ task: task({ url: "https://example.test" }), triggeredBy: "manual" });
    expect(result).toEqual(
      expect.objectContaining({ status: "failed", error: "HTTP 403: denied", resultSummary: "denied" }),
    );
  });

  // 空错误响应体必须回退到 HTTP 状态摘要。
  test("空错误响应体回退 HTTP 状态", async () => {
    installFetch(mockFetch(() => Promise.resolve(new Response("", { status: 502 }))));
    const result = await httpExecutor.execute({ task: task({ url: "https://example.test" }), triggeredBy: "manual" });
    expect(result).toEqual(expect.objectContaining({ status: "failed", error: "HTTP 502", resultSummary: "HTTP 502" }));
  });

  // 超时取消必须标记 timeout 而非普通失败。
  test("TimeoutError 映射为 timeout", async () => {
    const error = new Error("request timed out");
    error.name = "TimeoutError";
    installFetch(mockFetch(() => Promise.reject(error)));
    const result = await httpExecutor.execute({ task: task({ url: "https://example.test" }), triggeredBy: "manual" });
    expect(result).toEqual(
      expect.objectContaining({ status: "timeout", error: "request timed out", resultSummary: "request timed out" }),
    );
  });

  // AbortError 取消同样必须标记 timeout，便于调用方重试策略分类。
  test("AbortError 映射为 timeout", async () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    installFetch(mockFetch(() => Promise.reject(error)));
    expect(await httpExecutor.execute({ task: task({ url: "https://example.test" }), triggeredBy: "manual" })).toEqual(
      expect.objectContaining({ status: "timeout" }),
    );
  });

  // 网络异常必须保留诊断消息并按 failed 返回。
  test("网络异常返回失败诊断", async () => {
    installFetch(mockFetch(() => Promise.reject(new Error("network unavailable"))));
    expect(await httpExecutor.execute({ task: task({ url: "https://example.test" }), triggeredBy: "manual" })).toEqual(
      expect.objectContaining({ status: "failed", error: "network unavailable" }),
    );
  });
});
