import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";

const originalFetch = globalThis.fetch;

function response(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function installFetch(fetchStub: typeof fetch): void {
  globalThis.fetch = fetchStub;
}

function provider(): RagFlowKnowledgeProvider {
  return new RagFlowKnowledgeProvider();
}

beforeEach(() => {
  setConfig({ ragflowApiUrl: "http://ragflow.test", ragflowApiKey: "tenant-api-key", ragflowRequestTimeoutMs: 30_000 });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConfig();
});

describe("RagFlow 供应商管理真实分支", () => {
  // 已配置厂商列表必须过滤无名称项，避免前端渲染无效选择项。
  test("listConfiguredProviders 过滤无效厂商并保留有效名称", async () => {
    installFetch(
      mock(async () => response({ code: 0, data: [{ name: "OpenAI" }, {}, { name: "" }, { name: "RagFlow" }] })),
    );

    await expect(provider().listConfiguredProviders()).resolves.toEqual(["OpenAI", "RagFlow"]);
  });

  // 上游不可用时厂商列表必须降级为空数组，保证配置页仍可打开。
  test("listConfiguredProviders 在上游失败时降级为空数组", async () => {
    installFetch(mock(async () => response({ code: 500, message: "unavailable" })));

    await expect(provider().listConfiguredProviders()).resolves.toEqual([]);
  });

  // 实例列表必须编码厂商路径、补齐默认状态并保留区域信息。
  test("listProviderInstances 编码厂商路径并规范化实例字段", async () => {
    const fetchSpy = mock(async () =>
      response({
        code: 0,
        data: [{ instance_name: "primary", status: "inactive", region: "cn" }, { instance_name: "backup" }],
      }),
    );
    installFetch(fetchSpy);

    await expect(provider().listProviderInstances({ provider: "Open AI/中文" })).resolves.toEqual([
      { provider: "Open AI/中文", instanceName: "primary", status: "inactive", region: "cn" },
      { provider: "Open AI/中文", instanceName: "backup", status: "active", region: null },
    ]);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("Open%20AI%2F%E4%B8%AD%E6%96%87");
  });

  // 实例接口失败不应阻塞页面其它配置，必须返回空数组。
  test("listProviderInstances 在请求失败时降级为空数组", async () => {
    installFetch(mock(async () => response({ code: 403, message: "forbidden" })));

    await expect(provider().listProviderInstances({ provider: "OpenAI" })).resolves.toEqual([]);
  });

  // 模型管理只展示 embedding 模型，并应支持数组类型和默认状态。
  test("listInstanceModels 过滤非嵌入模型并映射数组类型", async () => {
    installFetch(
      mock(async () =>
        response({
          code: 0,
          data: [
            { name: "embed", model_type: ["chat", "embedding"], max_tokens: 8192 },
            { name: "chat", model_type: "chat" },
            { name: 42, model_type: "embedding" },
          ],
        }),
      ),
    );

    await expect(provider().listInstanceModels({ provider: "OpenAI", instanceName: "main" })).resolves.toEqual([
      {
        name: "embed",
        provider: "OpenAI",
        instance: "main",
        modelType: "chat,embedding",
        maxTokens: 8192,
        status: "active",
      },
    ]);
  });

  // 实例模型查询失败时必须降级为空数组，避免一个实例故障影响租户设置页。
  test("listInstanceModels 在请求失败时降级为空数组", async () => {
    installFetch(mock(async () => response({ code: 500, message: "broken" })));

    await expect(provider().listInstanceModels({ provider: "OpenAI", instanceName: "main" })).resolves.toEqual([]);
  });

  // 添加实例应修剪非空 baseUrl，同时通过 API key 覆盖租户凭据。
  test("addProviderInstance 发送修剪后的 baseUrl 与覆盖凭据", async () => {
    const fetchSpy = mock(async () => response({ code: 0 }));
    installFetch(fetchSpy);

    await expect(
      provider().addProviderInstance({
        apiKey: "org-key",
        provider: "Open AI",
        instanceName: "main",
        providerApiKey: "provider-key",
        baseUrl: " https://api.example.test ",
      }),
    ).resolves.toEqual({ instanceName: "main" });
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      instance_name: "main",
      api_key: "provider-key",
      base_url: "https://api.example.test",
    });
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer org-key");
  });

  // 空白 baseUrl 不能透传给上游，避免覆盖供应商默认地址。
  test("addProviderInstance 忽略空白 baseUrl", async () => {
    const fetchSpy = mock(async () => response({ code: 0 }));
    installFetch(fetchSpy);

    await provider().addProviderInstance({
      provider: "OpenAI",
      instanceName: "main",
      providerApiKey: "provider-key",
      baseUrl: "  ",
    });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({
      instance_name: "main",
      api_key: "provider-key",
    });
  });

  // 模型状态切换必须使用字符串状态和经过编码的所有路径段。
  test("setModelStatus 编码路径并发送 inactive 状态", async () => {
    const fetchSpy = mock(async () => response({ code: 0 }));
    installFetch(fetchSpy);

    await provider().setModelStatus({
      provider: "Open AI",
      instanceName: "prod/a",
      modelName: "embed v3",
      status: "inactive",
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toContain("Open%20AI/instances/prod%2Fa/models/embed%20v3");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ status: "inactive" });
  });

  // 删除实例只能传实例粒度的数组请求体，不能误删整个厂商。
  test("deleteProviderInstance 仅提交目标实例", async () => {
    const fetchSpy = mock(async () => response({ code: 0 }));
    installFetch(fetchSpy);

    await provider().deleteProviderInstance({ provider: "OpenAI", instanceName: "main" });

    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ instances: ["main"] });
  });

  // 新模型端点失败时已配置嵌入模型列表必须回退旧端点。
  test("listConfiguredEmbeddingModels 回退旧端点并映射 legacy 模型", async () => {
    const fetchSpy = mock(async (url: string) => {
      if (url.endsWith("/api/v1/models")) return response({ code: 500, message: "unsupported" });
      return response({
        code: 0,
        data: [{ llm_name: "embed", name: "Legacy", model_type: "embedding", status: "inactive" }],
      });
    });
    installFetch(fetchSpy);

    await expect(provider().listConfiguredEmbeddingModels()).resolves.toEqual([
      {
        name: "embed@Legacy",
        label: "Legacy · embed",
        provider: "Legacy",
        instance: "",
        modelType: "embedding",
        status: "inactive",
      },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // 两个模型端点均失败时必须返回空列表，而不是将上游异常暴露到租户界面。
  test("listConfiguredEmbeddingModels 双端点失败时降级为空数组", async () => {
    installFetch(mock(async () => response({ code: 500, message: "down" })));

    await expect(provider().listConfiguredEmbeddingModels()).resolves.toEqual([]);
  });

  // 图谱生成只允许 POST 到指定数据集端点且不得发送多余请求体。
  test("generateKnowledgeGraph 使用数据集图谱端点", async () => {
    const fetchSpy = mock(async () => response({ code: 0 }));
    installFetch(fetchSpy);

    await provider().generateKnowledgeGraph({
      knowledgeBaseRemoteId: "ds-1",
      remoteAccountId: "account",
      remoteUserId: "user",
    });

    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://ragflow.test/api/v1/datasets/ds-1/run_graphrag");
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(fetchSpy.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  // 没有图谱数据时查询应返回 null，避免伪造空图掩盖未生成状态。
  test("getKnowledgeGraph 在缺少 graph 字段时返回 null", async () => {
    installFetch(mock(async () => response({ code: 0, data: { mind_map: { root: "x" } } })));

    await expect(
      provider().getKnowledgeGraph({ knowledgeBaseRemoteId: "ds-1", remoteAccountId: "account", remoteUserId: "user" }),
    ).resolves.toBeNull();
  });

  // 图谱进度缺失时应稳定回退为零，避免前端出现 NaN 或 undefined。
  test("pollKnowledgeGraphProgress 为缺失数据提供零进度", async () => {
    installFetch(mock(async () => response({ code: 0, data: {} })));

    await expect(
      provider().pollKnowledgeGraphProgress({
        knowledgeBaseRemoteId: "ds-1",
        remoteAccountId: "account",
        remoteUserId: "user",
      }),
    ).resolves.toEqual({
      progress: 0,
      progressMsg: undefined,
      taskId: undefined,
    });
  });
});
