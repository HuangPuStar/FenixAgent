import { beforeEach, describe, expect, test } from "bun:test";

// In-memory localStorage mock
let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      store = {};
    },
    get length() {
      return Object.keys(store).length;
    },
    key: () => null,
  };
});

// Mock fetch
const fetchMock = {
  lastUrl: "",
  lastOpts: {} as RequestInit,
  response: { ok: true, status: 200, statusText: "OK" },
  responseData: {} as any,
};

beforeEach(() => {
  fetchMock.lastUrl = "";
  fetchMock.lastOpts = {};
  fetchMock.response = { ok: true, status: 200, statusText: "OK" };
  fetchMock.responseData = {};
});

(globalThis as any).fetch = async (url: string, opts: RequestInit) => {
  fetchMock.lastUrl = url;
  fetchMock.lastOpts = opts;
  const body = JSON.stringify(fetchMock.responseData);
  return {
    ok: fetchMock.response.ok,
    status: fetchMock.response.status,
    statusText: fetchMock.response.statusText,
    headers: new Map([["content-type", "application/json"]]),
    json: async () => fetchMock.responseData,
    text: async () => body,
  } as unknown as Response;
};

// =============================================================================
// Session SDK — 通过新 API 模块调用测试
// =============================================================================

describe("session SDK functions", () => {
  // 测试获取 session 详情发送 GET 请求（RESTful 路径参数模式）
  test("sessionApi.get — GET /web/sessions/:id", async () => {
    fetchMock.responseData = { id: "sess_1", title: "test" };
    const { sessionApi } = await import("../api/sessions");
    await sessionApi.get({ sessionId: "sess_1" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1");
    expect(fetchMock.lastOpts.method).toBe("GET");
    expect(fetchMock.lastOpts.body).toBeUndefined();
  });

  // 测试获取 session 历史发送 GET 请求（RESTful 路径参数模式）
  test("sessionApi.history — GET /web/sessions/:id/history", async () => {
    fetchMock.responseData = { events: [] };
    const { sessionApi } = await import("../api/sessions");
    await sessionApi.history({ sessionId: "sess_1" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/history");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  // 测试发送事件使用 RESTful 路径参数，sessionId 在 URL 中
  test("controlApi.sendEvent — POST /web/sessions/:id/events", async () => {
    fetchMock.responseData = { status: "ok" };
    const { controlApi } = await import("../api/sessions");
    await controlApi.sendEvent({ sessionId: "sess_1" }, { type: "user", content: "hello" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/events");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({
      type: "user",
      content: "hello",
    });
  });

  // 测试发送控制命令使用 RESTful 路径参数
  test("controlApi.control — POST /web/sessions/:id/control", async () => {
    fetchMock.responseData = { status: "ok" };
    const { controlApi } = await import("../api/sessions");
    await controlApi.control({ sessionId: "sess_1" }, { type: "resume" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/control");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({ type: "resume" });
  });

  // 测试中断命令使用 RESTful 路径参数，无 body
  test("controlApi.interrupt — POST /web/sessions/:id/interrupt", async () => {
    fetchMock.responseData = { success: true, data: null };
    const { controlApi } = await import("../api/sessions");
    await controlApi.interrupt({ sessionId: "sess_1" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/interrupt");
    expect(fetchMock.lastOpts.method).toBe("POST");
    // interrupt 无 body
    expect(fetchMock.lastOpts.body).toBeUndefined();
  });
});

// =============================================================================
// File SDK functions
// =============================================================================

describe("file SDK functions", () => {
  // 测试列出文件发送请求（method 未显式设置时 fetch 默认 GET）
  test("fileApi.listDir — GET /web/environments/:id/user", async () => {
    fetchMock.responseData = { success: true, data: { entries: [] } };
    const { fileApi } = await import("../api/files");
    await fileApi.listDir("s1");
    expect(fetchMock.lastUrl).toContain("/web/environments/s1/user");
    expect(fetchMock.lastOpts.method ?? "GET").toBe("GET");
  });

  // 测试列出文件带路径参数
  test("fileApi.listDir — with path query param", async () => {
    fetchMock.responseData = { success: true, data: { entries: [] } };
    const { fileApi } = await import("../api/files");
    await fileApi.listDir("s1", "docs/");
    expect(fetchMock.lastUrl).toContain("/web/environments/s1/user");
    expect(fetchMock.lastUrl).toContain("path=docs");
    expect(fetchMock.lastOpts.method ?? "GET").toBe("GET");
  });

  // 测试上传文件使用 FormData 和 POST
  test("fileApi.upload — uses FormData and POST", async () => {
    fetchMock.responseData = { success: true, data: { files: [] } };
    const { fileApi } = await import("../api/files");
    const file = new File(["content"], "test.txt");
    const formData = new FormData();
    formData.append("files", file);
    await fileApi.upload("s1", formData);
    expect(fetchMock.lastUrl).toContain("/web/environments/s1/user");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(fetchMock.lastOpts.body).toBeInstanceOf(FormData);
  });
});

describe("environment SDK functions", () => {
  test("envApi.del — DELETE /web/environments/:id", async () => {
    fetchMock.responseData = { success: true, data: null };
    const { envApi } = await import("../api/environments");
    await envApi.del({ id: "env_1" });
    expect(fetchMock.lastUrl).toContain("/web/environments/env_1");
    expect(fetchMock.lastOpts.method).toBe("DELETE");
  });
});

// =============================================================================
// Error handling — SDK Result pattern
// =============================================================================

describe("error handling", () => {
  // 测试非 ok 响应 SDK 返回 error 对象
  test("SDK returns error object on non-ok response", async () => {
    fetchMock.response = { ok: false, status: 401, statusText: "Unauthorized" };
    fetchMock.responseData = { success: false, error: { message: "Not authenticated" } };
    const { sessionApi } = await import("../api/sessions");
    const { data, error } = await sessionApi.get({ sessionId: "sess-1" });
    expect(error).not.toBeNull();
    expect(data).toBeUndefined();
  });

  // 测试 500 错误 SDK 返回 SERVER_ERROR
  test("SDK returns SERVER_ERROR on 500 response", async () => {
    fetchMock.response = { ok: false, status: 500, statusText: "Internal Server Error" };
    fetchMock.responseData = {};
    const { sessionApi } = await import("../api/sessions");
    const { error } = await sessionApi.list();
    expect(error).not.toBeNull();
    expect(error?.code).toBe("SERVER_ERROR");
  });
});

// =============================================================================
// UUID helper functions
// =============================================================================

describe("UUID helpers", () => {
  // 测试默认返回空字符串
  test("getUuid returns empty string by default", async () => {
    const { getUuid } = await import("../api/helpers");
    expect(getUuid()).toBe("");
  });

  // 测试设置和获取 UUID
  test("setUuid and getUuid roundtrip", async () => {
    const { getUuid, setUuid } = await import("../api/helpers");
    setUuid("test-uuid-123");
    expect(getUuid()).toBe("test-uuid-123");
  });
});
