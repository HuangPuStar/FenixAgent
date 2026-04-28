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
  return {
    ok: fetchMock.response.ok,
    status: fetchMock.response.status,
    statusText: fetchMock.response.statusText,
    json: async () => fetchMock.responseData,
  } as Response;
};

const client = await import("../api/client");

// =============================================================================
// api() — tested via exported functions
// =============================================================================

describe("api functions", () => {
  test("GET request uses correct path", async () => {
    fetchMock.responseData = [];
    await client.apiFetchAllSessions();
    expect(fetchMock.lastUrl).toBe("/web/sessions/all");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  test("GET request includes credentials", async () => {
    fetchMock.responseData = [];
    await client.apiFetchSessions();
    expect(fetchMock.lastOpts.credentials).toBe("include");
  });

  test("POST request includes JSON body", async () => {
    fetchMock.responseData = {};
    await client.apiBind("sess-1");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(fetchMock.lastOpts.body).toBe(JSON.stringify({ sessionId: "sess-1" }));
    expect(fetchMock.lastOpts.headers).toBeInstanceOf(Headers);
    expect((fetchMock.lastOpts.headers as Headers).get("Content-Type")).toBe("application/json");
  });

  test("throws error on non-ok response", async () => {
    fetchMock.response = { ok: false, status: 401, statusText: "Unauthorized" };
    fetchMock.responseData = { error: { type: "auth", message: "Not authenticated" } };
    await expect(client.apiFetchSessions()).rejects.toThrow("Not authenticated");
  });

  test("throws with statusText when error message is missing", async () => {
    fetchMock.response = { ok: false, status: 500, statusText: "Internal Server Error" };
    fetchMock.responseData = {};
    await expect(client.apiFetchSessions()).rejects.toThrow("Internal Server Error");
  });
});

// =============================================================================
// Instance API functions
// =============================================================================

describe("instance API functions", () => {
  test("apiCreateInstance — POST /web/instances", async () => {
    fetchMock.responseData = { id: "inst_xxx", port: 8888, status: "running", created_at: 1000 };
    await client.apiCreateInstance();
    expect(fetchMock.lastUrl).toBe("/web/instances");
    expect(fetchMock.lastOpts.method).toBe("POST");
  });

  test("apiListInstances — GET /web/instances", async () => {
    fetchMock.responseData = [];
    await client.apiListInstances();
    expect(fetchMock.lastUrl).toBe("/web/instances");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  test("apiDeleteInstance — DELETE /web/instances/:id", async () => {
    fetchMock.responseData = { ok: true };
    await client.apiDeleteInstance("inst_123");
    expect(fetchMock.lastUrl).toBe("/web/instances/inst_123");
    expect(fetchMock.lastOpts.method).toBe("DELETE");
  });
});

describe("channel API functions", () => {
  test("apiListChannelProviders — GET /web/channels/providers", async () => {
    fetchMock.responseData = [];
    await client.apiListChannelProviders();
    expect(fetchMock.lastUrl).toBe("/web/channels/providers");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  test("apiListChannels — GET /web/channels", async () => {
    fetchMock.responseData = [];
    await client.apiListChannels();
    expect(fetchMock.lastUrl).toBe("/web/channels");
    expect(fetchMock.lastOpts.method).toBe("GET");
  });

  test("apiCreateChannel — POST /web/channels", async () => {
    fetchMock.responseData = { id: "placeholder", type: "wechat", label: "微信", status: "disabled" };
    await client.apiCreateChannel("wechat");
    expect(fetchMock.lastUrl).toBe("/web/channels");
    expect(fetchMock.lastOpts.method).toBe("POST");
    expect(fetchMock.lastOpts.body).toBe(JSON.stringify({ type: "wechat" }));
  });
});
