import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubAuthApi, stubConfigPg, stubEnvironmentRepo } from "../test-utils/helpers";

const route = (await import("../routes/web/config/providers")).default;

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "provider-1",
    organizationId: "org-1",
    userId: "user-1",
    name: "openai",
    displayName: "OpenAI",
    protocol: "openai" as const,
    baseUrl: "https://api.example.test/",
    apiKey: "secret-1234",
    modelCount: 1,
    resourceKey: "org-1/provider-1",
    resourceAccess: {
      ownership: "internal",
      writable: true,
      manageable: true,
      sourceOrganizationId: "org-1",
      resourceUid: "provider-1",
      resourceKey: "org-1/provider-1",
    },
    models: [
      {
        id: "model-row-1",
        modelId: "gpt-test",
        displayName: "Test GPT",
        modalities: ["text"],
        limitConfig: { contextWindow: 128 },
        cost: { input: 1 },
        options: null,
        providerResourceAccess: { ownership: "internal", writable: true },
      },
    ],
    ...overrides,
  };
}

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function installDefaults() {
  stubEnvironmentRepo({ getBySecret: async () => null });
  stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });
  stubConfigPg({
    listProviders: async () => [],
    getProvider: async () => null,
    assertProviderInternalWritable: async () => null,
    upsertProvider: async () => "provider-1",
    deleteProvider: async () => false,
    addModel: async () => "model-row-2",
    updateModel: async () => true,
    removeModel: async () => true,
  });
}

function installFetch(response: Response | Error, seen?: { url: string; init: RequestInit | undefined }) {
  const fetchStub = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    if (seen) {
      seen.url = input.toString();
      seen.init = init;
    }
    if (response instanceof Error) throw response;
    return response;
  };
  globalThis.fetch = Object.assign(fetchStub, { preconnect: globalThis.fetch.preconnect });
}

describe("round54 Provider 配置 Web 路由", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    resetAllStubs();
    authenticate();
    installDefaults();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // 未认证请求必须在 Provider 列表服务之前被认证守卫拒绝。
  test("未认证列表不调用服务", async () => {
    let listed = false;
    stubConfigPg({
      listProviders: async () => {
        listed = true;
        return [];
      },
    });
    resetTestAuth();
    setTestOrgContext(null);

    expect((await request("/config/providers")).status).toBe(401);
    expect(listed).toBe(false);
  });

  // 列表查询必须使用认证注入的组织，而非客户端可控制的数据。
  test("列表传递认证组织", async () => {
    let organizationId = "";
    stubConfigPg({
      listProviders: async (ctx) => {
        organizationId = ctx.organizationId;
        return [];
      },
    });

    expect((await request("/config/providers")).status).toBe(200);
    expect(organizationId).toBe("org-1");
  });

  // 列表不得泄露 API key，只能返回脱敏后的 keyHint。
  test("列表脱敏 API key 并保留共享访问描述", async () => {
    stubConfigPg({
      listProviders: async () => [
        provider({
          apiKey: "top-secret-9876",
          resourceAccess: { ownership: "external", writable: false, resourceKey: "org-source/provider-source" },
        }),
      ],
    });

    const body = await (await request("/config/providers")).json();

    expect(body.data.providers[0]).toMatchObject({
      keyHint: "top-***876",
      resourceAccess: { ownership: "external", writable: false },
      resourceKey: "org-1/provider-1",
    });
    expect(JSON.stringify(body)).not.toContain("top-secret-9876");
  });

  // 详情读取支持带斜杠的共享 resource key，并将其完整传给隔离服务。
  test("详情读取共享 resource key", async () => {
    let receivedName = "";
    stubConfigPg({
      getProvider: async (_ctx, name) => {
        receivedName = name;
        return provider({
          resourceAccess: { ownership: "external", writable: false, resourceKey: "org-source/provider-1" },
        });
      },
    });

    const body = await (await request("/config/providers?name=org-source%2Fprovider-1")).json();

    expect(receivedName).toBe("org-source/provider-1");
    expect(body.data).toMatchObject({ keyHint: "secr***234", resourceKey: "org-source/provider-1" });
  });

  // 不存在的 Provider 应映射为标准 404，而不是成功空对象。
  test("详情不存在映射为 404", async () => {
    const response = await request("/config/providers?name=missing");

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 详情应把模型配置转换为面向前端的稳定字段名称。
  test("详情转换模型字段", async () => {
    stubConfigPg({ getProvider: async () => provider() });

    const body = await (await request("/config/providers?name=openai")).json();

    expect(body.data.models[0]).toEqual({
      id: "gpt-test",
      name: "Test GPT",
      modalities: ["text"],
      limit: { contextWindow: 128 },
      cost: { input: 1 },
      providerResourceAccess: { ownership: "internal", writable: true },
    });
  });

  // 更新未知协议时应保留已有协议，避免将无效值写进配置。
  test("更新未知协议保留已有协议", async () => {
    let saved: unknown;
    stubConfigPg({
      getProvider: async () => provider({ protocol: "anthropic" }),
      updateProviderById: async (_ctx, _providerId, data) => {
        saved = data;
        return true;
      },
    });

    expect((await json("/config/providers?name=openai", "PUT", { protocol: "unknown" })).status).toBe(200);
    expect(saved).toMatchObject({ protocol: "anthropic" });
  });

  // 外部只读 Provider 不得通过 upsert 写入。
  test("更新外部只读 Provider 返回 403", async () => {
    let written = false;
    stubConfigPg({
      getProvider: async () => provider({ resourceAccess: { writable: false } }),
      upsertProvider: async () => {
        written = true;
        return "provider-1";
      },
    });

    const response = await json("/config/providers?name=shared", "PUT", { name: "attempt" });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
    expect(written).toBe(false);
  });

  // 更新可携带 models，并分别走已有模型更新和新模型新增分支。
  test("更新同步新增和已有模型", async () => {
    const calls: string[] = [];
    stubConfigPg({
      getProvider: async () => provider(),
      updateProviderById: async () => true,
      assertProviderInternalWritable: async () => provider(),
      updateModel: async (_ctx, _providerId, modelId, data) => {
        calls.push(`update:${modelId}:${JSON.stringify(data)}`);
        return true;
      },
      addModel: async (_ctx, _providerId, data) => {
        calls.push(`add:${data.modelId}:${JSON.stringify(data)}`);
        return "model-row-2";
      },
    });

    expect(
      (
        await json("/config/providers?name=openai", "PUT", {
          models: { "gpt-test": { name: "Renamed" }, "new-model": { limit: { maxTokens: 42 } } },
        })
      ).status,
    ).toBe(200);
    expect(calls).toEqual([
      'update:gpt-test:{"displayName":"Renamed"}',
      'add:new-model:{"modelId":"new-model","limitConfig":{"maxTokens":42}}',
    ]);
  });

  // 删除前必须校验当前组织内可写性，找不到时映射为 404。
  test("删除不存在 Provider 返回 404", async () => {
    const response = await request("/config/providers?name=missing", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 删除服务竞争性失败也应保持 NOT_FOUND 语义。
  test("删除竞争失败返回 404", async () => {
    stubConfigPg({ assertProviderInternalWritable: async () => provider(), deleteProvider: async () => false });

    const response = await request("/config/providers?name=openai", { method: "DELETE" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 模型新增缺少 modelId 时不得调用 Provider 写入断言。
  test("新增模型缺少 modelId 返回 400", async () => {
    let checked = false;
    stubConfigPg({
      assertProviderInternalWritable: async () => {
        checked = true;
        return provider();
      },
    });

    const response = await json("/config/providers/actions/models?name=openai", "POST", {});

    expect(response.status).toBe(400);
    expect(checked).toBe(false);
  });

  // 同 Provider 下重复模型必须被拒绝而不调用 addModel。
  test("新增重复模型返回 400", async () => {
    let added = false;
    stubConfigPg({
      assertProviderInternalWritable: async () => provider(),
      addModel: async () => {
        added = true;
        return "model-row-2";
      },
    });

    const response = await json("/config/providers/actions/models?name=openai", "POST", { modelId: "gpt-test" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(added).toBe(false);
  });

  // 新增模型必须将前端字段映射到持久化模型字段。
  test("新增模型映射配置字段", async () => {
    let added: unknown;
    stubConfigPg({
      assertProviderInternalWritable: async () => provider(),
      addModel: async (_ctx, _providerId, data) => {
        added = data;
        return "model-row-2";
      },
    });

    const body = await (
      await json("/config/providers/actions/models?name=openai", "POST", {
        modelId: "new-model",
        name: "New Model",
        modalities: ["text", "image"],
        limit: { maxTokens: 99 },
        cost: { output: 2 },
        options: { reasoning: true },
      })
    ).json();

    expect(added).toEqual({
      modelId: "new-model",
      displayName: "New Model",
      modalities: ["text", "image"],
      limitConfig: { maxTokens: 99 },
      cost: { output: 2 },
      options: { reasoning: true },
    });
    expect(body.data).toEqual({ modelId: "new-model" });
  });

  // 更新不存在模型应返回 404，而不是隐式创建模型。
  test("更新不存在模型返回 404", async () => {
    stubConfigPg({ assertProviderInternalWritable: async () => provider({ models: [] }) });

    const response = await json("/config/providers/actions/models/gone?name=openai", "PUT", { name: "Gone" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 删除存在模型应将认证上下文、Provider ID 和模型 ID 一并交给服务层。
  test("删除模型调用隔离写入服务", async () => {
    let received = "";
    stubConfigPg({
      assertProviderInternalWritable: async () => provider(),
      removeModel: async (ctx, providerId, modelId) => {
        received = `${ctx.organizationId}/${providerId}/${modelId}`;
        return true;
      },
    });

    expect((await request("/config/providers/actions/models/gpt-test?name=openai", { method: "DELETE" })).status).toBe(
      200,
    );
    expect(received).toBe("org-1/provider-1/gpt-test");
  });

  // 获取模型列表缺少 name 时必须先完成路由参数验证。
  test("获取远程模型缺少 name 返回 400", async () => {
    const response = await json("/config/providers/actions/fetch-models", "POST", { apiKey: "key" });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
  });

  // 内联 OpenAI 连通性请求应规范化 v1 路径、Bearer 认证并过滤空模型 ID。
  test("获取 OpenAI 模型使用内联凭证", async () => {
    const seen = { url: "", init: undefined as RequestInit | undefined };
    installFetch(new Response(JSON.stringify({ data: [{ id: "gpt-a" }, { id: "" }, {}] }), { status: 200 }), seen);

    const body = await (
      await json("/config/providers/actions/fetch-models?name=draft", "POST", {
        apiKey: "inline-key",
        baseURL: "https://remote.example.test///",
        protocol: "openai",
      })
    ).json();

    expect(seen.url).toBe("https://remote.example.test/v1/models");
    expect(new Headers(seen.init?.headers).get("authorization")).toBe("Bearer inline-key");
    expect(body.data).toEqual({ models: ["gpt-a"] });
  });

  // Anthropic 列表的 404 应保留协议、状态和配置模型提示。
  test("获取 Anthropic 模型映射 404 提示", async () => {
    installFetch(new Response("not ready", { status: 404 }));

    const response = await json("/config/providers/actions/fetch-models?name=draft", "POST", {
      apiKey: "inline-key",
      protocol: "anthropic",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "PROVIDER_TEST_LIST_HTTP_ERROR" },
      data: { protocol: "anthropic", status: 404, detail: "not ready", hint: "configure_model_then_test_model" },
    });
  });

  // 无效模型列表响应应映射为专用错误码，避免误报可用模型。
  test("获取模型拒绝缺失 data 数组", async () => {
    installFetch(new Response(JSON.stringify({ models: [] }), { status: 200 }));

    const response = await json("/config/providers/actions/fetch-models?name=draft", "POST", { apiKey: "inline-key" });

    expect(response.status).toBe(500);
    expect((await response.json()).error.code).toBe("PROVIDER_TEST_LIST_RESPONSE_INVALID");
  });

  // 存储 Provider 的模型测试必须拒绝外部共享只读资源。
  test("测试共享只读 Provider 返回 403", async () => {
    stubConfigPg({
      assertProviderInternalWritable: async () => {
        throw new AppError("read-only", "FORBIDDEN", 403);
      },
    });

    const response = await json("/config/providers/actions/test-model?name=shared", "POST", { modelId: "gpt-test" });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  // OpenAI 模型测试应发送固定探测消息并返回非字符串内容中的文本。
  test("测试 OpenAI 模型提取分段文本", async () => {
    const seen = { url: "", init: undefined as RequestInit | undefined };
    installFetch(
      new Response(
        JSON.stringify({ choices: [{ message: { content: [{ text: " hello " }, { content: "world" }] } }] }),
        {
          status: 200,
        },
      ),
      seen,
    );
    stubConfigPg({ assertProviderInternalWritable: async () => provider() });

    const body = await (
      await json("/config/providers/actions/test-model?name=openai", "POST", { modelId: "gpt-test" })
    ).json();

    expect(seen.url).toBe("https://api.example.test/v1/chat/completions");
    expect(JSON.parse(String(seen.init?.body))).toMatchObject({ model: "gpt-test", max_tokens: 32 });
    expect(body.data).toEqual({ ok: true, content: "hello \nworld" });
  });

  // 请求异常必须标准化为请求失败，且不得暴露 API key。
  test("模型测试映射请求异常且不泄露密钥", async () => {
    installFetch(new Error("connection refused"));
    stubConfigPg({ assertProviderInternalWritable: async () => provider({ apiKey: "never-disclose-key" }) });

    const response = await json("/config/providers/actions/test-model?name=openai", "POST", { modelId: "gpt-test" });
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toMatchObject({
      error: { code: "CONFIG_TEST_REQUEST_FAILED" },
      data: { target: "model", reason: "request_failed" },
    });
    expect(JSON.stringify(body)).not.toContain("never-disclose-key");
  });
});
