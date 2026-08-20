import { afterEach, describe, expect, test } from "bun:test";
import type { ScheduledTaskV2Row } from "../repositories/task-v2";
import { httpExecutor } from "../services/scheduler/http-executor";

const originalFetch = globalThis.fetch;

function task(definition: unknown, timeoutSeconds = 1): ScheduledTaskV2Row {
  return {
    id: "round60-http-task",
    userId: "user-1",
    organizationId: "org-1",
    name: "round60 http",
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

function installFetch(handler: (url: string, init: RequestInit) => Promise<Response>): void {
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    handler(String(input), init ?? {});
  globalThis.fetch = Object.assign(fetchStub, { preconnect: originalFetch.preconnect });
}

function execute(definition: unknown, timeoutSeconds = 1) {
  return httpExecutor.execute({ task: task(definition, timeoutSeconds), triggeredBy: "manual" });
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("round60 scheduler HTTP executor", () => {
  // 执行器应声明自己处理 HTTP 类型任务。
  test("声明 http 执行器类型", () => {
    expect(httpExecutor.type).toBe("http");
  });

  // 未指定方法时应构造 POST、JSON Content-Type 和原始请求体。
  test("默认 POST 构造 JSON 请求", async () => {
    let captured: RequestInit | undefined;
    installFetch(async (_url, init) => {
      captured = init;
      return new Response("created", { status: 201 });
    });

    const result = await execute({ url: "https://scheduler.invalid/hooks", body: '{"job":60}' });

    expect(captured).toEqual(
      expect.objectContaining({ method: "POST", body: '{"job":60}', headers: { "Content-Type": "application/json" } }),
    );
    expect(result).toEqual(expect.objectContaining({ status: "success", resultSummary: "created" }));
  });

  // 小写方法应规范化为大写后再交给 fetch。
  test("规范化请求方法大小写", async () => {
    let method = "";
    installFetch(async (_url, init) => {
      method = init.method ?? "";
      return new Response("ok");
    });

    await execute({ url: "https://scheduler.invalid/patch", method: "patch", body: "payload" });

    expect(method).toBe("PATCH");
  });

  // GET 请求不能携带请求体或默认 JSON Content-Type。
  test("GET 排除请求体和默认内容类型", async () => {
    let captured: RequestInit | undefined;
    installFetch(async (_url, init) => {
      captured = init;
      return new Response(null, { status: 204 });
    });

    await execute({ url: "https://scheduler.invalid/read", method: "get", body: "ignored" });

    expect(captured).toEqual(expect.objectContaining({ method: "GET", body: undefined, headers: {} }));
  });

  // 调用方提供的鉴权头必须完整透传，不能被默认头覆盖。
  test("透传 Authorization 鉴权头", async () => {
    let headers: RequestInit["headers"] | undefined;
    installFetch(async (_url, init) => {
      headers = init.headers;
      return new Response("authorized");
    });

    await execute({
      url: "https://scheduler.invalid/protected",
      headers: { Authorization: "Bearer test-token", "X-Request-Id": "round60" },
    });

    expect(headers).toEqual({
      Authorization: "Bearer test-token",
      "X-Request-Id": "round60",
      "Content-Type": "application/json",
    });
  });

  // 大小写不同的 content-type 已存在时也不得额外添加默认头。
  test("识别小写 content-type", async () => {
    let headers: RequestInit["headers"] | undefined;
    installFetch(async (_url, init) => {
      headers = init.headers;
      return new Response("ok");
    });

    await execute({ url: "https://scheduler.invalid/plain", headers: { "content-type": "text/plain" } });

    expect(headers).toEqual({ "content-type": "text/plain" });
  });

  // 未提供 body 的非 GET 请求应显式传递 undefined，而不是串行化空值。
  test("缺少请求体时不串行化空值", async () => {
    let body: RequestInit["body"] | null | undefined;
    installFetch(async (_url, init) => {
      body = init.body;
      return new Response("ok");
    });

    await execute({ url: "https://scheduler.invalid/empty" });

    expect(body).toBeUndefined();
  });

  // URL 必须原样交给 fetch，避免执行器篡改路径或查询参数。
  test("保留完整请求 URL", async () => {
    let url = "";
    installFetch(async (input) => {
      url = input;
      return new Response("ok");
    });

    await execute({ url: "https://scheduler.invalid/hooks?attempt=60&source=manual" });

    expect(url).toBe("https://scheduler.invalid/hooks?attempt=60&source=manual");
  });

  // 空的成功响应应使用 HTTP 状态作为摘要。
  test("空成功响应回退 HTTP 状态摘要", async () => {
    installFetch(async () => new Response(null, { status: 204 }));

    const result = await execute({ url: "https://scheduler.invalid/no-content" });

    expect(result).toEqual(expect.objectContaining({ status: "success", resultSummary: "HTTP 204" }));
  });

  // 过长成功响应必须被限制为 2000 个字符，避免持久化过量结果。
  test("截断过长成功响应摘要", async () => {
    const content = "s".repeat(2001);
    installFetch(async () => new Response(content));

    const result = await execute({ url: "https://scheduler.invalid/large-success" });

    expect(result.resultSummary).toBe("s".repeat(2000));
  });

  // 非 2xx 响应应保留状态码、响应摘要和诊断错误。
  test("失败响应返回状态与诊断", async () => {
    installFetch(async () => new Response("forbidden", { status: 403 }));

    const result = await execute({ url: "https://scheduler.invalid/forbidden" });

    expect(result).toEqual(
      expect.objectContaining({ status: "failed", resultSummary: "forbidden", error: "HTTP 403: forbidden" }),
    );
  });

  // 失败响应的错误信息上限应比结果摘要更严格。
  test("限制失败响应错误长度", async () => {
    const content = "e".repeat(600);
    installFetch(async () => new Response(content, { status: 500 }));

    const result = await execute({ url: "https://scheduler.invalid/large-error" });

    expect(result.resultSummary).toBe(content);
    expect(result.error).toBe(`HTTP 500: ${"e".repeat(500)}`);
  });

  // 读取响应体失败时应安全降级为 HTTP 状态摘要。
  test("响应体读取异常时安全降级", async () => {
    installFetch(async () => {
      const response = new Response("unreadable", { status: 502 });
      Object.defineProperty(response, "text", { value: async () => Promise.reject(new Error("stream closed")) });
      return response;
    });

    const result = await execute({ url: "https://scheduler.invalid/broken-body" });

    expect(result).toEqual(expect.objectContaining({ status: "failed", resultSummary: "HTTP 502", error: "HTTP 502" }));
  });

  // 普通网络异常应标记 failed 并保留诊断信息。
  test("网络异常返回失败诊断", async () => {
    installFetch(async () => Promise.reject(new TypeError("network unavailable")));

    const result = await execute({ url: "https://scheduler.invalid/network-error" });

    expect(result).toEqual(expect.objectContaining({ status: "failed", error: "network unavailable" }));
  });

  // 非 Error 拒绝值也应转换为可记录的失败信息。
  test("非 Error 拒绝值转换为字符串", async () => {
    installFetch(async () => Promise.reject("connection lost"));

    const result = await execute({ url: "https://scheduler.invalid/string-error" });

    expect(result).toEqual(
      expect.objectContaining({ status: "failed", error: "connection lost", resultSummary: "connection lost" }),
    );
  });

  // TimeoutError 必须分类为 timeout，供调度器采用超时重试策略。
  test("TimeoutError 分类为超时", async () => {
    installFetch(async () => {
      const error = new Error("deadline exceeded");
      error.name = "TimeoutError";
      return Promise.reject(error);
    });

    const result = await execute({ url: "https://scheduler.invalid/timeout" });

    expect(result).toEqual(expect.objectContaining({ status: "timeout", error: "deadline exceeded" }));
  });

  // AbortError 也必须分类为 timeout，覆盖取消后的调度语义。
  test("AbortError 分类为超时", async () => {
    installFetch(async () => {
      const error = new Error("request aborted");
      error.name = "AbortError";
      return Promise.reject(error);
    });

    const result = await execute({ url: "https://scheduler.invalid/aborted" });

    expect(result).toEqual(expect.objectContaining({ status: "timeout", error: "request aborted" }));
  });

  // 配置的零秒超时应传入已触发的 AbortSignal，避免遗留请求资源。
  test("零秒超时取消请求信号", async () => {
    let signal: AbortSignal | null | undefined;
    installFetch(async (_url, init) => {
      signal = init.signal;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return Promise.reject(signal?.reason);
    });

    const result = await execute({ url: "https://scheduler.invalid/immediate-timeout" }, 0);

    expect(signal?.aborted).toBe(true);
    expect(result.status).toBe("timeout");
  });

  // 空超时配置应回退到默认值，并且每次执行都创建独立的请求信号。
  test("默认超时创建独立请求信号", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    installFetch(async (_url, init) => {
      signals.push(init.signal);
      return new Response("ok");
    });

    await execute({ url: "https://scheduler.invalid/first" });
    await execute({ url: "https://scheduler.invalid/second" });

    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
  });
});
