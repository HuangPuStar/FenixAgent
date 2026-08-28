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

    const { request } = await import("../api/request");
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

    const { request, unwrap, ApiError } = await import("../api/request");

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
});

describe("request bearerToken", () => {
  // 帮助函数：执行请求后取出 fetch 调用的 RequestInit，便于断言注入的请求头。
  async function fetchInitFor(options: Parameters<typeof import("../api/request").request>[1]) {
    const { request } = await import("../api/request");
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
