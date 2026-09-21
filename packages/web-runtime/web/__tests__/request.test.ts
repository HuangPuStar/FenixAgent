import { beforeEach, describe, expect, mock, test } from "bun:test";

const fetchMock = { status: 200, body: {} as unknown };

beforeEach(() => {
  fetchMock.status = 200;
  fetchMock.body = {};
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(fetchMock.body), {
        status: fetchMock.status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  ) as unknown as typeof fetch;
});

describe("request helpers", () => {
  // 后端自定义错误码和 data 需要保留，页面才能识别“先配置模型再测试”的提示分支。
  test("preserves backend custom error code and data", async () => {
    fetchMock.status = 404;
    fetchMock.body = {
      success: false,
      error: {
        code: "PROVIDER_TEST_LIST_HTTP_ERROR",
        message: "PROVIDER_TEST_LIST_HTTP_ERROR",
      },
      data: {
        protocol: "anthropic",
        status: 404,
        hint: "configure_model_then_test_model",
      },
    };

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request<{ models: string[] }>("/web/config/providers/actions/fetch-models", {
      method: "POST",
      query: { name: "anthropic" },
      body: {},
    });

    expect(result.success).toBe(false);
    expect(result.error).toEqual({
      code: "PROVIDER_TEST_LIST_HTTP_ERROR",
      message: "PROVIDER_TEST_LIST_HTTP_ERROR",
      data: {
        protocol: "anthropic",
        status: 404,
        hint: "configure_model_then_test_model",
      },
    });
  });

  // unwrap 抛出的 ApiError 也要带上 data，组件才能用 hint 区分真实错误和兜底提示。
  test("unwrap keeps backend error metadata on ApiError", async () => {
    fetchMock.status = 404;
    fetchMock.body = {
      success: false,
      error: {
        code: "PROVIDER_TEST_LIST_HTTP_ERROR",
        message: "PROVIDER_TEST_LIST_HTTP_ERROR",
      },
      data: {
        protocol: "anthropic",
        status: 404,
        hint: "configure_model_then_test_model",
      },
    };

    const { request, unwrap, ApiError } = await import("@fenix/web-runtime/api/request");

    try {
      await unwrap(
        request<{ models: string[] }>("/web/config/providers/actions/fetch-models", {
          method: "POST",
          query: { name: "anthropic" },
          body: {},
        }),
      );
      throw new Error("expected unwrap to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as InstanceType<typeof ApiError>;
      expect(apiError.code).toBe("PROVIDER_TEST_LIST_HTTP_ERROR");
      expect(apiError.data).toEqual({
        protocol: "anthropic",
        status: 404,
        hint: "configure_model_then_test_model",
      });
    }
  });

  // 字符串错误是历史接口的合法失败载荷，公共层必须保留其诊断文本。
  test("normalizes string error payload", async () => {
    fetchMock.status = 503;
    fetchMock.body = { success: false, error: "Hindsight service unavailable" };

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request("/web/hindsight/status");

    expect(result.error?.message).toBe("Hindsight service unavailable");
  });

  // 空错误消息不能覆盖可定位的 HTTP 状态兜底。
  test("falls back for empty error message", async () => {
    fetchMock.status = 503;
    fetchMock.body = { success: false, error: { message: "" } };

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request("/web/hindsight/status");

    expect(result.error?.message).toBe("请求失败 (503)");
  });

  // 仅含空白的错误消息与空字符串等价，不能作为用户可见诊断。
  test("falls back for whitespace-only error message", async () => {
    fetchMock.status = 503;
    fetchMock.body = { success: false, error: { message: "   " } };

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request("/web/hindsight/status");

    expect(result.error?.message).toBe("请求失败 (503)");
  });

  // 非 JSON HTTP 错误应返回统一状态消息，不能因解析失败退化为网络错误。
  test("falls back for non-JSON HTTP error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("upstream unavailable", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        }),
      ),
    ) as unknown as typeof fetch;

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request("/web/hindsight/status");

    expect(result.error?.message).toBe("请求失败 (503)");
  });

  // 声明 JSON 的 HTTP 错误即使响应体损坏，也应保留 HTTP 语义而不能误报为网络故障。
  test("falls back for malformed JSON HTTP error", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("{invalid-json", {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request("/web/hindsight/status");

    expect(result.error).toEqual({ code: "SERVER_ERROR", message: "请求失败 (503)" });
  });

  // 2xx 响应的 JSON 声明与实际内容不符时，应按现有异常响应合同返回服务端错误。
  test("reports malformed JSON success response as unexpected server format", async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response("{invalid-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetch;

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request("/web/hindsight/status");

    expect(result.error).toEqual({ code: "SERVER_ERROR", message: "服务器返回了意外的响应格式" });
  });

  // 未知 JSON 错误结构应安全回退，不把对象字符串泄露给页面。
  test("falls back for unknown JSON error payload", async () => {
    fetchMock.status = 503;
    fetchMock.body = { success: false, error: { detail: "upstream unavailable" } };

    const { request } = await import("@fenix/web-runtime/api/request");
    const result = await request("/web/hindsight/status");

    expect(result.error?.message).toBe("请求失败 (503)");
  });
});

describe("request bearerToken", () => {
  // 帮助函数：执行请求后取出 fetch 调用的 RequestInit，便于断言注入的请求头。
  async function fetchInitFor(options: Parameters<typeof import("@fenix/web-runtime/api/request").request>[1]) {
    const { request } = await import("@fenix/web-runtime/api/request");
    await request<{ ok: boolean }>("/web/test", options);
    const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
    return calls[calls.length - 1]?.[1];
  }

  // bearerToken 置入时应自动注入 Authorization: Bearer <token>。
  test("bearerToken 注入 Authorization 头", async () => {
    const init = await fetchInitFor({ bearerToken: "sys-key-1" });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sys-key-1");
  });

  // 未设置 bearerToken 时行为完全不变，不注入任何 Authorization 头。
  test("未设置 bearerToken 时不注入 Authorization", async () => {
    const init = await fetchInitFor({});
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBeNull();
  });

  // 调用方显式 headers.Authorization 与 bearerToken 冲突时，显式 headers 优先。
  test("显式 headers.Authorization 优先于 bearerToken", async () => {
    const init = await fetchInitFor({ bearerToken: "sys-key-1", headers: { Authorization: "Bearer explicit-key" } });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer explicit-key");
  });
});
