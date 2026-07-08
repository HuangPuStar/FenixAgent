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
    const result = await request("/web/config/providers/actions/fetch-models", {
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
        request("/web/config/providers/actions/fetch-models", {
          method: "POST",
          query: { name: "anthropic" },
          body: {},
        }),
      );
      throw new Error("expected unwrap to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).code).toBe("PROVIDER_TEST_LIST_HTTP_ERROR");
      expect((error as ApiError).data).toEqual({
        protocol: "anthropic",
        status: 404,
        hint: "configure_model_then_test_model",
      });
    }
  });
});
