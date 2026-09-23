import { beforeEach, describe, expect, mock, test } from "bun:test";
import { getEventListeners } from "node:events";

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

/** 执行请求后取出 fetch 调用的 RequestInit，便于断言注入与合并之后的请求头。 */
async function fetchInitFor(options: Parameters<typeof import("@fenix/web-runtime/api/request").request>[1]) {
  const { request } = await import("@fenix/web-runtime/api/request");
  await request<{ ok: boolean }>("/web/test", options);
  const calls = (globalThis.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls;
  return calls[calls.length - 1]?.[1];
}

/** 永不结束的响应体：只在请求被 abort 时以 AbortError 收尾，用来模拟「响应头已到、body 迟迟不来」。 */
function stalledBody(init?: RequestInit): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      init?.signal?.addEventListener("abort", () => streamController.error(new DOMException("Aborted", "AbortError")));
    },
  });
}

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
});

describe("内部头优先（调用方不可覆盖）", () => {
  // 鉴权头由 bearerToken 决定：调用方夹带 Authorization 时内部值必须胜出，否则任何调用点都能劫持鉴权。
  test("内部 authorization 不被调用方 headers 覆盖", async () => {
    const init = await fetchInitFor({ bearerToken: "sys-key-1", headers: { Authorization: "Bearer explicit-key" } });
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer sys-key-1");
  });

  // 内容类型与幂等键同样由基建决定：调用方同名头（含大小写不同的写法）不得改写，否则 JSON 体与幂等去重会静默失效。
  test("内部 content-type 与 x-file-op-id 不被调用方同名头覆盖", async () => {
    const init = await fetchInitFor({
      body: { name: "demo" },
      opId: "op-1",
      headers: { "Content-Type": "text/plain", "X-File-Op-Id": "caller-op" },
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-file-op-id")).toBe("op-1");
  });

  // 内部头优先不等于调用方 headers 失效：条件请求等透传头仍要送达（否则 If-None-Match 会被静默丢弃）。
  test("调用方 headers 仍能补充内部未设置的头", async () => {
    const init = await fetchInitFor({ headers: { "If-None-Match": 'W/"etag-1"' } });
    const headers = new Headers(init?.headers);
    expect(headers.get("if-none-match")).toBe('W/"etag-1"');
  });
});

describe("请求超时与取消", () => {
  // 超时必须覆盖 body 消费：收到响应头就清定时器会让慢 json() 逃出超时约束，请求永不返回（页面永久 loading）。
  test("超时覆盖 JSON 响应体的消费", async () => {
    globalThis.fetch = mock((_url: string, init?: RequestInit) =>
      Promise.resolve(
        new Response(stalledBody(init), { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    ) as unknown as typeof fetch;
    const { request } = await import("@fenix/web-runtime/api/request");

    const result = await request<{ ok: boolean }>("/web/slow", { timeout: 20 });

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: "NETWORK_ERROR", message: "请求超时" });
  });

  // 非 JSON 响应的 body 同样受超时约束，且要归一为 transport 失败——body 读不动不是「响应格式异常」。
  test("超时覆盖非 JSON 响应体的消费", async () => {
    globalThis.fetch = mock((_url: string, init?: RequestInit) =>
      Promise.resolve(new Response(stalledBody(init), { status: 200, headers: { "Content-Type": "text/plain" } })),
    ) as unknown as typeof fetch;
    const { request } = await import("@fenix/web-runtime/api/request");

    const result = await request("/web/slow", { timeout: 20 });

    expect(result.success).toBe(false);
    expect(result.error).toEqual({ code: "NETWORK_ERROR", message: "请求超时" });
  });

  // 合并到调用方 signal 上的监听器必须随请求结束摘除：外部 signal 生命周期远长于单次请求（如页面级取消信号），
  // 残留监听器会随每次请求累积到它被 abort。
  test("请求结束后摘除挂在调用方 signal 上的监听器", async () => {
    const controller = new AbortController();
    const listenersDuringRequest: number[] = [];
    globalThis.fetch = mock(() => {
      listenersDuringRequest.push(getEventListeners(controller.signal, "abort").length);
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { ok: true } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as unknown as typeof fetch;
    const { request } = await import("@fenix/web-runtime/api/request");

    await request("/web/test", { signal: controller.signal });

    // 请求进行中确实挂了监听（若为 0 说明本用例没有覆盖到合并路径，后面的断言等于空转）
    expect(listenersDuringRequest).toEqual([1]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
