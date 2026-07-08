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
  // 测试 providers 列表使用 GET 请求返回正确数据
  test("providerApi.list uses GET and returns providers array", async () => {
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
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers");
    expect(call[1].method).toBeUndefined(); // GET is default, no explicit method
  });

  // 测试 set provider 使用 PUT 发送正确 payload（mock 200，走更新路径，query param 风格）
  test("providerApi.set sends PUT payload for existing provider", async () => {
    fetchMock.body = { success: true, data: { name: "openai", keyHint: "sk-...abc" } };
    const { providerApi } = await import("../api/providers");
    await providerApi.set("openai", { apiKey: "sk-test" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers?name=openai");
    expect(call[1].method).toBe("PUT");
    const body = JSON.parse(call[1].body);
    expect(body).toEqual({ apiKey: "sk-test" });
  });

  // 测试 set provider 在 PUT 返回 404 时回退到 POST 创建（query param 风格）
  test("providerApi.set falls back to POST when PUT returns 404", async () => {
    let callCount = 0;
    globalThis.fetch = mock((_url: string, _init?: RequestInit) => {
      callCount++;
      if (callCount === 1) {
        // PUT 返回 404
        return Promise.resolve(
          new Response(JSON.stringify({ success: false, error: { code: "NOT_FOUND", message: "Not found" } }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        ) as Promise<Response>;
      }
      // POST 返回成功
      return Promise.resolve(
        new Response(JSON.stringify({ success: true, data: { name: "new-provider" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ) as Promise<Response>;
    }) as unknown as typeof fetch;

    const { providerApi } = await import("../api/providers");
    const result = await providerApi.set("new-provider", { apiKey: "sk-new" });
    expect(result.success).toBe(true);
    expect(callCount).toBe(2);

    // 验证 PUT 请求（query param 风格）
    const calls = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls;
    expect(calls[0][0]).toBe("/web/config/providers?name=new-provider");
    expect(calls[0][1].method).toBe("PUT");
    expect(JSON.parse(calls[0][1].body)).toEqual({ apiKey: "sk-new" });

    // 验证 POST 回退
    expect(calls[1][0]).toBe("/web/config/providers");
    expect(calls[1][1].method).toBe("POST");
    expect(JSON.parse(calls[1][1].body)).toEqual({ name: "new-provider", apiKey: "sk-new" });
  });

  // 测试 fetchModels 使用 /actions/fetch-models + query param 端点
  test("providerApi.fetchModels uses POST to provider fetch-models endpoint", async () => {
    fetchMock.body = { success: true, data: { models: ["gpt-4", "gpt-3.5"] } };
    const { providerApi } = await import("../api/providers");
    const { data, error } = await providerApi.fetchModels("openai");
    expect(error).toBeUndefined();
    expect((data as any).models).toEqual(["gpt-4", "gpt-3.5"]);
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers/actions/fetch-models?name=openai");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({});
  });

  // 测试 fetchModels 携带 inline 参数（query param 风格）
  test("providerApi.fetchModels sends inline credentials in body", async () => {
    fetchMock.body = { success: true, data: { models: ["claude-3"] } };
    const { providerApi } = await import("../api/providers");
    await providerApi.fetchModels("anthropic", { apiKey: "sk-inline", protocol: "anthropic" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers/actions/fetch-models?name=anthropic");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ apiKey: "sk-inline", protocol: "anthropic" });
  });

  // 测试 testModel 使用 /actions/test-model + query param 端点
  test("providerApi.testModel uses POST to models/test endpoint", async () => {
    fetchMock.body = { success: true, data: { ok: true, content: "Hello" } };
    const { providerApi } = await import("../api/providers");
    await providerApi.testModel("openai", "gpt-4");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers/actions/test-model?name=openai");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ modelId: "gpt-4" });
  });

  // 测试 del provider 使用 DELETE + query param
  test("providerApi.del uses DELETE method", async () => {
    fetchMock.body = { success: true, data: null };
    const { providerApi } = await import("../api/providers");
    await providerApi.del("openai");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers?name=openai");
    expect(call[1].method).toBe("DELETE");
  });

  // 测试 addModel 使用 /actions/models + query param
  test("providerApi.addModel uses POST to models endpoint", async () => {
    fetchMock.body = { success: true, data: { modelId: "gpt-4" } };
    const { providerApi } = await import("../api/providers");
    await providerApi.addModel("openai", { modelId: "gpt-4", name: "GPT-4" });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers/actions/models?name=openai");
    expect(call[1].method).toBe("POST");
    expect(JSON.parse(call[1].body)).toEqual({ modelId: "gpt-4", name: "GPT-4" });
  });

  // 测试 updateModel 使用 /actions/models/:modelId + query param
  test("providerApi.updateModel uses PUT to specific model endpoint", async () => {
    fetchMock.body = { success: true, data: { modelId: "gpt-4" } };
    const { providerApi } = await import("../api/providers");
    await providerApi.updateModel("openai", "gpt-4", { limit: { context: 128000 } });
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers/actions/models/gpt-4?name=openai");
    expect(call[1].method).toBe("PUT");
    expect(JSON.parse(call[1].body)).toEqual({ limit: { context: 128000 } });
  });

  // 测试 removeModel 使用 /actions/models/:modelId + query param
  test("providerApi.removeModel uses DELETE to specific model endpoint", async () => {
    fetchMock.body = { success: true, data: { modelId: "gpt-4" } };
    const { providerApi } = await import("../api/providers");
    await providerApi.removeModel("openai", "gpt-4");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/providers/actions/models/gpt-4?name=openai");
    expect(call[1].method).toBe("DELETE");
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

  // 测试 delete skill 使用 RESTful DELETE + 路径参数模式
  test("skillConfigApi.del sends DELETE to path parameter endpoint", async () => {
    fetchMock.body = { success: true, data: null };
    const { skillConfigApi } = await import("../api/skills");
    await skillConfigApi.del("my-skill");
    const call = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0];
    expect(call[0]).toBe("/web/config/skills/my-skill");
    expect(call[1].method).toBe("DELETE");
  });

  // 测试非 200 状态码返回 error（GET provider 返回 404）
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
