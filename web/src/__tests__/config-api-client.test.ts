import { beforeEach, describe, expect, mock, test } from "bun:test";

// Mock fetch
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

describe("config SDK modules", () => {
  // 测试 providers 列表返回正确数据
  test("providerApi.list returns providers array", async () => {
    fetchMock.body = {
      success: true,
      data: { providers: [{ name: "openai", protocol: "openai", keyHint: "sk-...abc", baseURL: "" }] },
    };
    const { providerApi } = await import("../api/providers");
    const { data, error } = await providerApi.list();
    expect(error).toBeUndefined();
    const result = data as any;
    expect(result.providers).toHaveLength(1);
    expect(result.providers[0].name).toBe("openai");
  });

  // 测试 set provider 发送正确 payload
  test("providerApi.set sends correct payload", async () => {
    fetchMock.body = { success: true, data: { name: "openai", keyHint: "sk-...abc" } };
    const { providerApi } = await import("../api/providers");
    await providerApi.set("openai", { keyHint: "sk-test" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body.action).toBe("set");
    expect(body.name).toBe("openai");
    expect(body.data).toEqual({ keyHint: "sk-test" });
  });

  // 测试 test provider 返回模型列表
  test("providerApi.test returns models", async () => {
    fetchMock.body = { success: true, data: { models: ["gpt-4", "gpt-3.5"] } };
    const { providerApi } = await import("../api/providers");
    const { data, error } = await providerApi.test("openai");
    expect(error).toBeUndefined();
    expect((data as any).models).toEqual(["gpt-4", "gpt-3.5"]);
  });

  // 测试 get models 返回 ModelConfig
  test("modelApi.get returns ModelConfig", async () => {
    fetchMock.body = { success: true, data: { current: { model: "gpt-4", small_model: null }, available: [] } };
    const { modelApi } = await import("../api/models");
    const { data, error } = await modelApi.get();
    expect(error).toBeUndefined();
    expect((data as any).current.model).toBe("gpt-4");
  });

  // 测试 create agent 使用独立创建接口
  test("agentApi.create sends create payload to dedicated endpoint", async () => {
    fetchMock.body = { success: true, data: { name: "my-agent" } };
    const { agentApi } = await import("../api/agents");
    await agentApi.create("my-agent", { modelId: "model-1" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/agents");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      name: "my-agent",
      data: { modelId: "model-1" },
    });
  });

  // 测试 update agent 使用 PUT 接口并携带 data 载荷
  test("agentApi.set sends update payload to PUT endpoint", async () => {
    fetchMock.body = { success: true, data: { name: "my-agent" } };
    const { agentApi } = await import("../api/agents");
    await agentApi.set("my-agent", { prompt: "updated" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/agents?name=my-agent");
    expect(call[1].method).toBe("PUT");
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({
      data: { prompt: "updated" },
    });
  });

  // 测试 delete skill 使用 POST + action 分发模式
  test("skillConfigApi.del sends delete action via POST", async () => {
    fetchMock.body = { success: true, data: null };
    const { skillConfigApi } = await import("../api/skills");
    await skillConfigApi.del("my-skill");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/skills");
    expect(call[1].method).toBe("POST");
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ action: "delete", name: "my-skill" });
  });

  // 测试非 200 状态码返回 error
  test("non-200 response returns error", async () => {
    fetchMock.status = 404;
    fetchMock.body = { success: false, error: { code: "NOT_FOUND", message: "Not found" } };
    const { providerApi } = await import("../api/providers");
    const { error } = await providerApi.get("xxx");
    expect(error).not.toBeNull();
  });

  // 测试 upload skills 使用 FormData
  test("skillConfigApi.upload uses FormData", async () => {
    fetchMock.body = { success: true, data: { imported: [], skipped: [], conflicts: [] } };
    const { skillConfigApi } = await import("../api/skills");
    const formData = new FormData();
    formData.append("manifest", "[]");
    await skillConfigApi.upload(formData);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/skills/upload");
    expect(call[1].method).toBe("POST");
    expect(call[1].body).toBe(formData);
  });

  // 测试错误响应正确传递 error code 和 message
  test("error response carries code and message", async () => {
    fetchMock.status = 409;
    fetchMock.body = {
      success: false,
      error: { code: "VALIDATION_ERROR", message: "Conflict" },
    };
    const { providerApi } = await import("../api/providers");
    const { error } = await providerApi.get("demo");

    expect(error).not.toBeNull();
    expect(error?.code).toBe("VALIDATION_ERROR");
    expect(error?.message).toBe("Conflict");
  });
});
