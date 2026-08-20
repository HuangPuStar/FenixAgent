import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";

const originalFetch = globalThis.fetch;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function mockFetch(implementation: FetchStub) {
  return mock<FetchStub>(implementation);
}

function installFetch(fetchStub: FetchStub): void {
  globalThis.fetch = fetchStub as unknown as typeof fetch;
}

beforeEach(() => {
  setConfig({
    ragflowApiUrl: "http://ragflow.test",
    ragflowApiKey: "test-api-key",
    ragflowRequestTimeoutMs: 30_000,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConfig();
});

describe("RagFlowKnowledgeProvider 补充覆盖", () => {
  // 数据集列表应只保留调用方需要的 id 与名称。
  test("listDatasets 映射数据集列表并注入覆盖用 API key", async () => {
    const fetchSpy = mockFetch(async () =>
      jsonResponse({ code: 0, data: [{ id: "ds-1", name: "资料库", description: "忽略" }] }),
    );
    installFetch(fetchSpy);

    const result = await new RagFlowKnowledgeProvider().listDatasets({ apiKey: "tenant-key" });

    expect(result).toEqual([{ id: "ds-1", name: "资料库" }]);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://ragflow.test/api/v1/datasets");
    expect(new Headers(fetchSpy.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe("Bearer tenant-key");
  });

  // 数据集详情应识别内置解析器并规范化嵌入模型。
  test("getDataset 映射内置解析器和分块配置", async () => {
    installFetch(
      mockFetch(async () =>
        jsonResponse({
          code: 0,
          data: { embedding_model: " embed@instance@provider ", parser_id: "naive", chunk_method: "book" },
        }),
      ),
    );

    await expect(new RagFlowKnowledgeProvider().getDataset({ datasetId: "ds-1" })).resolves.toEqual({
      embeddingModel: "embed@instance@provider",
      chunkMethod: "naive",
      parseMethod: "builtin",
    });
  });

  // 不存在的数据集详情应返回 null 而不是伪造默认配置。
  test("getDataset 在上游失败时返回 null", async () => {
    installFetch(mockFetch(async () => jsonResponse({ code: 102, message: "not found" })));

    await expect(new RagFlowKnowledgeProvider().getDataset({ datasetId: "missing" })).resolves.toBeNull();
  });

  // 模型列表应在新端点失败后降级到旧端点并过滤目标类型。
  test("listEmbeddingModels 回退旧模型端点并映射两段式模型标识", async () => {
    const fetchSpy = mockFetch(async (url) => {
      if (String(url).endsWith("/api/v1/models")) return jsonResponse({ code: 500, message: "unsupported" });
      return jsonResponse({
        code: 0,
        data: [
          { llm_name: "text-embed", name: "Legacy", model_type: "embedding" },
          { llm_name: "rerank", name: "Legacy", model_type: "rerank" },
        ],
      });
    });
    installFetch(fetchSpy);

    await expect(new RagFlowKnowledgeProvider().listEmbeddingModels()).resolves.toEqual([
      { name: "text-embed@Legacy", label: "Legacy · text-embed", provider: "Legacy", instance: "" },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  // pipeline 列表应接受多语言标题并过滤缺失 ID 的项。
  test("listPipelines 映射多语言画布标题并过滤无效项", async () => {
    installFetch(
      mockFetch(async () =>
        jsonResponse({
          code: 0,
          data: { canvas: [{ id: "pipe-1", title: { en: "English", zh: "中文" } }, { title: "无 ID" }], total: 2 },
        }),
      ),
    );

    await expect(new RagFlowKnowledgeProvider().listPipelines()).resolves.toEqual([{ id: "pipe-1", name: "English" }]);
  });

  // 厂商连接失败应转换为可展示的失败结果，避免泄露请求体中的密钥。
  test("verifyProviderConnection 映射业务错误为失败结果", async () => {
    installFetch(mockFetch(async () => jsonResponse({ code: 403, message: "connection rejected" })));

    await expect(
      new RagFlowKnowledgeProvider().verifyProviderConnection({
        provider: "Test Provider",
        providerApiKey: "provider-secret",
        baseUrl: " https://provider.test ",
      }),
    ).resolves.toEqual({ success: false, message: "code=403: connection rejected" });
  });

  // 模型目录请求应编码路径参数并映射多类型和 token 上限。
  test("listProviderModels 编码厂商名并映射模型响应", async () => {
    const fetchSpy = mockFetch(async () =>
      jsonResponse({ code: 0, data: [{ name: "embed", model_type: ["embedding", "rerank"], max_tokens: 8192 }] }),
    );
    installFetch(fetchSpy);

    await expect(
      new RagFlowKnowledgeProvider().listProviderModels({
        provider: "Test Provider/中文",
        providerApiKey: "provider-secret",
        baseUrl: "https://models.test",
        modelType: "embedding",
      }),
    ).resolves.toEqual([{ name: "embed", modelType: "embedding,rerank", maxTokens: 8192 }]);
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("Test%20Provider%2F%E4%B8%AD%E6%96%87");
  });

  // 文档删除的 405 兼容路径应使用集合端点和 ids 请求体。
  test("deleteResource 在旧文档端点不支持时回退集合删除", async () => {
    const fetchSpy = mockFetch(async (_url, init) => {
      if (init?.body) return jsonResponse({ code: 0 });
      return jsonResponse({ code: 405, message: "MethodNotAllowed" }, 405);
    });
    installFetch(fetchSpy);

    await new RagFlowKnowledgeProvider().deleteResource({
      knowledgeBaseRemoteId: "ds-1",
      resourceRemoteId: "doc-1",
      remoteAccountId: "account",
      remoteUserId: "user",
    });

    expect(fetchSpy.mock.calls[1]?.[0]).toBe("http://ragflow.test/api/v1/datasets/ds-1/documents");
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({ ids: ["doc-1"] });
  });

  // 资源状态更新和重解析应发送 RagFlow 要求的数值状态及 ingest 参数。
  test("setResourceEnabled 与 reparseResource 映射写入请求体", async () => {
    const fetchSpy = mockFetch(async () => jsonResponse({ code: 0 }));
    installFetch(fetchSpy);
    const provider = new RagFlowKnowledgeProvider();

    await provider.setResourceEnabled({ resourceRemoteId: "doc-1", knowledgeBaseRemoteId: "ds-1", enabled: false });
    await provider.reparseResource({ resourceRemoteId: "doc-1", knowledgeBaseRemoteId: "ds-1", deleteOld: true });

    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ doc_ids: ["doc-1"], status: 0 });
    expect(JSON.parse(String(fetchSpy.mock.calls[1]?.[1]?.body))).toEqual({
      doc_ids: ["doc-1"],
      run: 1,
      delete: true,
      apply_kb: false,
    });
  });

  // 分块分页应保留请求页码、关键词，并计算跨页的 chunkIndex。
  test("listChunks 映射分页分块和启用状态", async () => {
    const fetchSpy = mockFetch(async () =>
      jsonResponse({
        code: 0,
        data: {
          total: 9,
          chunks: [{ id: "chunk-1", content: "内容", important_keywords: ["关键词"], available_int: 0 }],
        },
      }),
    );
    installFetch(fetchSpy);

    await expect(
      new RagFlowKnowledgeProvider().listChunks({
        knowledgeBaseRemoteId: "ds-1",
        resourceRemoteId: "doc-1",
        remoteAccountId: "account",
        remoteUserId: "user",
        page: 2,
        pageSize: 3,
        keyword: " 检索词 ",
      }),
    ).resolves.toEqual({
      items: [{ id: "chunk-1", content: "内容", chunkIndex: 4, importantKeywords: ["关键词"], enabled: false }],
      total: 9,
      page: 2,
      pageSize: 3,
    });
    expect(fetchSpy.mock.calls[0]?.[0]).toContain("page=2&page_size=3&keywords=%E6%A3%80%E7%B4%A2%E8%AF%8D");
  });

  // 切换分块状态应使用 PATCH 和数值 available 字段。
  test("switchChunk 将布尔状态映射为 RagFlow available 数值", async () => {
    const fetchSpy = mockFetch(async () => jsonResponse({ code: 0 }));
    installFetch(fetchSpy);

    await new RagFlowKnowledgeProvider().switchChunk({
      knowledgeBaseRemoteId: "ds-1",
      resourceRemoteId: "doc-1",
      chunkId: "chunk-1",
      available: true,
      remoteAccountId: "account",
      remoteUserId: "user",
    });

    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toEqual({ available: 1 });
  });

  // 图谱读取应补齐缺失的节点和边，并原样保留 mind_map。
  test("getKnowledgeGraph 映射图谱响应的默认集合", async () => {
    installFetch(mockFetch(async () => jsonResponse({ code: 0, data: { graph: {}, mind_map: { root: "知识" } } })));

    await expect(
      new RagFlowKnowledgeProvider().getKnowledgeGraph({
        knowledgeBaseRemoteId: "ds-1",
        remoteAccountId: "account",
        remoteUserId: "user",
      }),
    ).resolves.toEqual({ graph: { nodes: [], edges: [] }, mind_map: { root: "知识" } });
  });

  // 删除不存在图谱是幂等操作，不应向调用方暴露 code=102。
  test("deleteKnowledgeGraph 将图不存在业务码视为成功", async () => {
    installFetch(mockFetch(async () => jsonResponse({ code: 102, message: "graph not found" })));

    await expect(
      new RagFlowKnowledgeProvider().deleteKnowledgeGraph({
        knowledgeBaseRemoteId: "ds-1",
        remoteAccountId: "account",
        remoteUserId: "user",
      }),
    ).resolves.toBeUndefined();
  });

  // 图谱进度接口应为缺失字段提供零进度默认值。
  test("pollKnowledgeGraphProgress 映射图谱任务进度", async () => {
    installFetch(mockFetch(async () => jsonResponse({ code: 0, data: { progress_msg: "处理中", task_id: "task-1" } })));

    await expect(
      new RagFlowKnowledgeProvider().pollKnowledgeGraphProgress({
        knowledgeBaseRemoteId: "ds-1",
        remoteAccountId: "account",
        remoteUserId: "user",
      }),
    ).resolves.toEqual({ progress: 0, progressMsg: "处理中", taskId: "task-1" });
  });

  // 通用检索应透传可选参数，并将 RagFlow chunk 映射为统一搜索结果。
  test("search 映射检索响应并保留分页过滤参数", async () => {
    const fetchSpy = mockFetch(async () =>
      jsonResponse({
        code: 0,
        data: {
          chunks: [
            { content: "答案", document_name: "文档", document_id: "doc-1", dataset_id: "ds-1", similarity: 0.88 },
          ],
        },
      }),
    );
    installFetch(fetchSpy);

    await expect(
      new RagFlowKnowledgeProvider().search({
        knowledgeBases: [{ remoteId: "ds-1", remoteAccountId: "account", remoteUserId: "user" }],
        query: "问题",
        topK: 5,
        page: 2,
        pageSize: 10,
        useKg: true,
        crossLanguages: ["en"],
        metaDataFilter: { method: "auto" },
      }),
    ).resolves.toEqual([
      { title: "文档", snippet: "答案", source: "文档", score: 0.88, knowledgeBaseId: "ds-1", resourceId: "doc-1" },
    ]);
    expect(JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body))).toMatchObject({
      dataset_ids: ["ds-1"],
      page: 2,
      page_size: 10,
      use_kg: true,
      cross_languages: ["en"],
      meta_data_filter: { method: "auto" },
    });
  });

  // 检索测试接口应映射兼容字段、关键词字符串及文档聚合。
  test("searchDetailed 映射 datasets/search 的兼容字段和聚合", async () => {
    installFetch(
      mockFetch(async () =>
        jsonResponse({
          code: 0,
          data: {
            count: 1,
            chunks: [
              {
                id: "chunk-1",
                content: "答案",
                docnm_kwd: "文档",
                doc_id: "doc-1",
                kb_id: "ds-1",
                important_kwd: "甲, 乙",
              },
            ],
            doc_aggs: [{ doc_name: "文档", doc_id: "doc-1", count: 1 }],
          },
        }),
      ),
    );

    await expect(
      new RagFlowKnowledgeProvider().searchDetailed({
        knowledgeBases: [{ remoteId: "ds-1", remoteAccountId: "account", remoteUserId: "user" }],
        query: "问题",
        topK: 3,
      }),
    ).resolves.toEqual({
      chunks: [
        {
          chunkId: "chunk-1",
          content: "答案",
          documentName: "文档",
          documentId: "doc-1",
          datasetId: "ds-1",
          similarity: 0,
          importantKeywords: ["甲", "乙"],
        },
      ],
      total: 1,
      docAggs: [{ documentName: "文档", documentId: "doc-1", count: 1 }],
    });
  });

  // 请求超时时应传播 AbortError，确保调用方可区分网络失败。
  test("listDatasets 在超时时中止 fetch 并传播 AbortError", async () => {
    setConfig({ ragflowRequestTimeoutMs: 1 });
    installFetch(
      mock(
        (input: string | URL | Request, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );

    await expect(new RagFlowKnowledgeProvider().listDatasets({})).rejects.toThrow("aborted");
  });
});
