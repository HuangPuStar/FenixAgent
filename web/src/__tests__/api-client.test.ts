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
  // 测试创建 session 发送 POST 请求
  test("sessionApi.create — POST /web/sessions", async () => {
    fetchMock.responseData = { success: true, data: { id: "sess_1", title: "test" } };
    const { sessionApi } = await import("../api/sessions");
    await sessionApi.create({ title: "test" });
    expect(fetchMock.lastUrl).toContain("/web/sessions");
    expect(fetchMock.lastOpts.method).toBe("POST");
  });

  // 测试获取 session 详情发送 POST 请求（action 分发模式）
  test("sessionApi.get — POST /web/sessions with action=get", async () => {
    fetchMock.responseData = { success: true, data: { id: "sess_1", title: "test" } };
    const { sessionApi } = await import("../api/sessions");
    await sessionApi.get({ sessionId: "sess_1" });
    expect(fetchMock.lastUrl).toContain("/web/sessions");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({ action: "get", sessionId: "sess_1" });
  });

  // 测试获取 session 历史发送 POST 请求（action 分发模式）
  test("sessionApi.history — POST /web/sessions with action=history", async () => {
    fetchMock.responseData = { success: true, data: { events: [] } };
    const { sessionApi } = await import("../api/sessions");
    await sessionApi.history({ sessionId: "sess_1" });
    expect(fetchMock.lastUrl).toContain("/web/sessions");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({ action: "history", sessionId: "sess_1" });
  });

  // 测试发送事件包含 JSON body（action 分发模式，sessionId 展平到顶层）
  test("controlApi.sendEvent — POST with JSON body", async () => {
    fetchMock.responseData = { success: true, data: {} };
    const { controlApi } = await import("../api/control");
    await controlApi.sendEvent({ sessionId: "sess_1" }, { type: "user", content: "hello" });
    expect(fetchMock.lastUrl).toContain("/web/control");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({
      action: "send_event",
      sessionId: "sess_1",
      type: "user",
      content: "hello",
    });
  });

  // 测试发送控制命令包含 JSON body（action 分发模式）
  test("controlApi.control — POST with JSON body", async () => {
    fetchMock.responseData = { success: true, data: {} };
    const { controlApi } = await import("../api/control");
    await controlApi.control({ sessionId: "sess_1" }, { type: "resume" });
    expect(fetchMock.lastUrl).toContain("/web/control");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({
      action: "control",
      sessionId: "sess_1",
      type: "resume",
    });
  });

  // 测试中断命令
  test("controlApi.interrupt — POST interrupt", async () => {
    fetchMock.responseData = { success: true, data: {} };
    const { controlApi } = await import("../api/control");
    await controlApi.interrupt({ sessionId: "sess_1" });
    expect(fetchMock.lastUrl).toContain("/web/control");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({ action: "interrupt", sessionId: "sess_1" });
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
