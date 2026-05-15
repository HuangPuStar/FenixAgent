import { describe, test, expect, beforeEach } from "bun:test";

// In-memory localStorage mock
let store: Record<string, string> = {};

beforeEach(() => {
  store = {};
  (globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
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
  } as Response;
};

const client = await import("../api/client");

// =============================================================================
// Eden Treaty session API — 通过 client 代理调用测试
// =============================================================================

describe("session API functions (Eden Treaty)", () => {
  // 测试创建 session 发送 POST 请求
  test("createSession — POST /web/sessions", async () => {
    fetchMock.responseData = { id: "sess_1", title: "test" };
    await client.client.web.sessions.post({ title: "test" });
    expect(fetchMock.lastUrl).toContain("/web/sessions");
    expect(fetchMock.lastOpts.method).toBe("POST");
  });

  // 测试获取 session 详情发送 GET 请求
  test("fetchSession — GET /web/sessions/:id", async () => {
    fetchMock.responseData = { id: "sess_1", title: "test" };
    await client.client.web.sessions({ id: "sess_1" }).get();
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  // 测试获取 session 历史发送 GET 请求
  test("fetchSessionHistory — GET /web/sessions/:id/history", async () => {
    fetchMock.responseData = { events: [] };
    await client.client.web.sessions({ id: "sess_1" }).history.get();
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/history");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  // 测试发送事件包含 JSON body
  test("sendEvent — POST with JSON body", async () => {
    fetchMock.responseData = {};
    await client.client.web.sessions({ id: "sess_1" }).events.post({ type: "user", content: "hello" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/events");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({ type: "user", content: "hello" });
  });

  // 测试发送控制命令包含 JSON body
  test("sendControl — POST with JSON body", async () => {
    fetchMock.responseData = {};
    await client.client.web.sessions({ id: "sess_1" }).control.post({ type: "resume" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/control");
    expect(fetchMock.lastOpts.method).toBe("POST");
  });

  // 测试中断命令
  test("interrupt — POST interrupt", async () => {
    fetchMock.responseData = {};
    await client.client.web.sessions({ id: "sess_1" }).control.post({ type: "interrupt" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/sess_1/control");
    expect(JSON.parse(fetchMock.lastOpts.body as string)).toEqual({ type: "interrupt" });
  });
});

// =============================================================================
// File API functions (Eden Treaty)
// =============================================================================

describe("file API functions (Eden Treaty)", () => {
  // 测试列出文件发送 GET 请求
  test("listFiles — GET /web/sessions/:id/user", async () => {
    fetchMock.responseData = { entries: [] };
    await client.client.web.sessions({ id: "s1" }).user.get();
    expect(fetchMock.lastUrl).toContain("/web/sessions/s1/user");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  // 测试列出文件带路径参数
  test("listFiles — with path query param", async () => {
    fetchMock.responseData = { entries: [] };
    await client.client.web.sessions({ id: "s1" }).user.get({ path: "docs/" });
    expect(fetchMock.lastUrl).toContain("/web/sessions/s1/user");
    // Eden Treaty passes query params via fetch options, verify the call was made
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  // 测试上传文件使用 fetchUpload 和 FormData
  test("fetchUpload — uses FormData and POST", async () => {
    fetchMock.responseData = { files: [] };
    const file = new File(["content"], "test.txt");
    const formData = new FormData();
    formData.append("files", file);
    await client.fetchUpload("/web/sessions/s1/user/docs/", formData);
    expect(fetchMock.lastUrl).toBe("/web/sessions/s1/user/docs/");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(fetchMock.lastOpts.body).toBeInstanceOf(FormData);
  });
});

// =============================================================================
// Error handling
// =============================================================================

describe("error handling", () => {
  // 测试非 ok 响应 Eden Treaty 仍然返回数据（不自动抛错）
  test("Eden Treaty returns data even on non-ok response", async () => {
    fetchMock.response = { ok: false, status: 401, statusText: "Unauthorized" };
    fetchMock.responseData = { error: { message: "Not authenticated" } };
    const result = await client.client.web.sessions({ id: "sess-1" }).get();
    expect(result).toBeDefined();
  });

  // 测试 fetchUpload 在非 ok 响应时抛出错误
  test("fetchUpload throws error on non-ok response", async () => {
    fetchMock.response = { ok: false, status: 401, statusText: "Unauthorized" };
    fetchMock.responseData = { error: { message: "Not authenticated" } };
    await expect(client.fetchUpload("/web/test", new FormData())).rejects.toThrow("Not authenticated");
  });

  // 测试 fetchUpload 在缺少错误消息时使用 statusText
  test("fetchUpload throws with statusText when error message is missing", async () => {
    fetchMock.response = { ok: false, status: 500, statusText: "Internal Server Error" };
    fetchMock.responseData = {};
    await expect(client.fetchUpload("/web/test", new FormData())).rejects.toThrow("Internal Server Error");
  });
});

// =============================================================================
// UUID helper functions
// =============================================================================

describe("UUID helpers", () => {
  // 测试默认返回空字符串
  test("getUuid returns empty string by default", () => {
    expect(client.getUuid()).toBe("");
  });

  // 测试设置和获取 UUID
  test("setUuid and getUuid roundtrip", () => {
    client.setUuid("test-uuid-123");
    expect(client.getUuid()).toBe("test-uuid-123");
  });
});
