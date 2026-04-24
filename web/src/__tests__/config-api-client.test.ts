import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock fetch
const fetchMock = { status: 200, body: {} as unknown };
const originalFetch = globalThis.fetch;

beforeEach(() => {
  fetchMock.status = 200;
  fetchMock.body = {};
  globalThis.fetch = mock(() =>
    Promise.resolve(new Response(JSON.stringify(fetchMock.body), { status: fetchMock.status, headers: { "Content-Type": "application/json" } }))
  ) as typeof fetch;
});

describe("config api client", () => {
  test("apiListProviders returns providers array", async () => {
    fetchMock.body = { success: true, data: { providers: [{ name: "openai", configured: true, keyHint: "sk-...abc", baseURL: "" }] } };
    const { apiListProviders } = await import("../api/client");
    const result = await apiListProviders();
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("openai");
  });

  test("apiSetProvider sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "openai", keyHint: "sk-...abc" } };
    const { apiSetProvider } = await import("../api/client");
    await apiSetProvider("openai", { apiKey: "sk-test" });
    const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("set");
    expect(body.name).toBe("openai");
    expect(body.data).toEqual({ apiKey: "sk-test" });
  });

  test("apiTestProvider returns models", async () => {
    fetchMock.body = { success: true, data: { models: ["gpt-4", "gpt-3.5"] } };
    const { apiTestProvider } = await import("../api/client");
    const result = await apiTestProvider("openai");
    expect(result.models).toEqual(["gpt-4", "gpt-3.5"]);
  });

  test("apiGetModels returns ModelConfig", async () => {
    fetchMock.body = { success: true, data: { current: { model: "gpt-4", small_model: null }, available: [] } };
    const { apiGetModels } = await import("../api/client");
    const result = await apiGetModels();
    expect(result.current.model).toBe("gpt-4");
  });

  test("apiCreateAgent sends create action", async () => {
    fetchMock.body = { success: true, data: { name: "my-agent" } };
    const { apiCreateAgent } = await import("../api/client");
    await apiCreateAgent("my-agent", { model: "gpt-4" });
    const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("create");
  });

  test("apiDeleteSkill sends delete action", async () => {
    fetchMock.body = { success: true, data: null };
    const { apiDeleteSkill } = await import("../api/client");
    await apiDeleteSkill("my-skill");
    const call = (globalThis.fetch as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("delete");
  });

  test("error response throws", async () => {
    fetchMock.body = { success: false, error: { code: "NOT_FOUND", message: "Not found" } };
    const { apiGetProvider } = await import("../api/client");
    expect(apiGetProvider("xxx")).rejects.toThrow("Not found");
  });
});
