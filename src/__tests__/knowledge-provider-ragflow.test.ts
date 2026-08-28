// src/__tests__/knowledge-provider-ragflow.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { checkRagFlowHealth, RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = originalFetch;
  setConfig({
    ragflowApiUrl: "http://ragflow.test",
    ragflowApiKey: "test-api-key",
    ragflowRequestTimeoutMs: 30000,
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetConfig();
});

describe("RagFlowKnowledgeProvider", () => {
  test("createKnowledgeBase 在未配置 API key 时抛出明确错误", async () => {
    setConfig({ ragflowApiKey: "" });
    const fetchSpy = mock(async () => ({
      ok: true,
      text: async () => JSON.stringify({ code: 0, data: { id: "unused" } }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.createKnowledgeBase({
        organizationId: "org1",
        userId: "user1",
        slug: "test-kb",
        name: "Test KB",
      }),
    ).rejects.toThrow("RAGFLOW_API_KEY is not configured");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("createKnowledgeBase 使用 organizationId 作为 RagFlow dataset 名前缀", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { id: "ds_abc123", name: "[org_org1] Test KB" } }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const result = await provider.createKnowledgeBase({
      organizationId: "org1",
      userId: "user1",
      slug: "test-kb",
      name: "Test KB",
      description: "A test knowledge base",
    });

    expect(result.remoteId).toBe("ds_abc123");
    expect(result.name).toBe("Test KB");
    expect(result.status).toBe("empty");
  });

  test("deleteKnowledgeBase 调用 DELETE /api/v1/datasets/{id} 删除整个 dataset", async () => {
    const fetchSpy = mock(async () => ({
      ok: true,
      json: async () => ({ code: 0 }),
      text: async () => JSON.stringify({ code: 0 }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await provider.deleteKnowledgeBase({
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    const url = (fetchSpy as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/datasets/ds_abc123");
  });

  test("deleteKnowledgeBase 遇到旧路径 405 时回退到集合端点删除 dataset", async () => {
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      if (init?.body) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0 }),
        };
      }
      return {
        ok: false,
        status: 405,
        text: async () => JSON.stringify({ code: 100, message: "<MethodNotAllowed '405: Method Not Allowed'>" }),
      };
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await provider.deleteKnowledgeBase({
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const fallbackUrl = (fetchSpy as ReturnType<typeof mock>).mock.calls[1][0] as string;
    const fallbackInit = (fetchSpy as ReturnType<typeof mock>).mock.calls[1][1] as RequestInit;
    expect(fallbackUrl).toBe("http://ragflow.test/api/v1/datasets");
    expect(fallbackInit.method).toBe("DELETE");
    expect(JSON.parse(fallbackInit.body as string)).toEqual({ ids: ["ds_abc123"] });
  });

  test("deleteKnowledgeBase 接受 204 空响应作为删除成功", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 204,
      text: async () => "",
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.deleteKnowledgeBase({
        knowledgeBaseRemoteId: "ds_abc123",
        remoteAccountId: "user1",
        remoteUserId: "user1",
      }),
    ).resolves.toBeUndefined();
  });

  test("deleteKnowledgeBase API 返回非 0 code 时抛出异常", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      text: async () => JSON.stringify({ code: 102, message: "Dataset not found" }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.deleteKnowledgeBase({
        knowledgeBaseRemoteId: "ds_nonexistent",
        remoteAccountId: "user1",
        remoteUserId: "user1",
      }),
    ).rejects.toThrow("102");
  });

  test("addResource 上传后立刻返回 processing，并异步触发解析", async () => {
    const fetchSpy = mock(async () => ({ ok: true, json: async () => ({ code: 0, data: [{ id: "doc_xyz" }] }) }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const result = await provider.addResource({
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
      filePath: "/tmp/test.pdf",
      sourceName: "test.pdf",
    });

    expect(result.remoteId).toBe("doc_xyz");
    expect(result.status).toBe("processing");
    expect(result.knowledgeBaseRemoteId).toBe("ds_abc123");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("addResource 上传响应 data 数组为空时抛出异常", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: [] }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.addResource({
        knowledgeBaseRemoteId: "ds_abc123",
        remoteAccountId: "user1",
        remoteUserId: "user1",
        filePath: "/tmp/test.pdf",
        sourceName: "test.pdf",
      }),
    ).rejects.toThrow("unexpected response");
  });

  test("addResource 上传 API 返回业务错误 code 时抛出异常", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ code: 102, message: "Duplicate file" }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.addResource({
        knowledgeBaseRemoteId: "ds_abc123",
        remoteAccountId: "user1",
        remoteUserId: "user1",
        filePath: "/tmp/test.pdf",
        sourceName: "test.pdf",
      }),
    ).rejects.toThrow("Duplicate file");
  });

  test("addResource wait=false 同样直接返回 processing", async () => {
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof init.body === "string") {
        return { ok: true, json: async () => ({ code: 0 }) };
      }
      return { ok: true, json: async () => ({ code: 0, data: [{ id: "doc_abc" }] }) };
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const result = await provider.addResource({
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
      filePath: "/tmp/test.pdf",
      sourceName: "test.pdf",
      wait: false,
    });

    expect(result.status).toBe("processing");
    expect(result.remoteId).toBe("doc_abc");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("addResource 不因后台解析失败而在创建阶段抛错", async () => {
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === "POST" && typeof init.body === "string") {
        return { ok: true, json: async () => ({ code: 0 }) };
      }
      return { ok: true, json: async () => ({ code: 0, data: [{ id: "doc_fail" }] }) };
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.addResource({
        knowledgeBaseRemoteId: "ds_abc123",
        remoteAccountId: "user1",
        remoteUserId: "user1",
        filePath: "/tmp/bad.pdf",
        sourceName: "bad.pdf",
      }),
    ).resolves.toMatchObject({
      remoteId: "doc_fail",
      status: "processing",
    });
  });

  test("listResources 正确映射 RagFlow run 到接口状态", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          total: 4,
          docs: [
            { id: "d1", name: "doc1.pdf", run: "UNSTART" },
            { id: "d2", name: "doc2.pdf", run: "RUNNING" },
            { id: "d3", name: "doc3.pdf", run: "DONE" },
            { id: "d4", name: "doc4.pdf", run: "FAIL", progress_msg: "error" },
          ],
        },
      }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const results = await provider.listResources({
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    expect(results).toHaveLength(4);
    expect(results[0].status).toBe("pending");
    expect(results[1].status).toBe("processing");
    expect(results[2].status).toBe("ready");
    expect(results[3].status).toBe("error");
    expect(results[3].lastError).toBe("error");
  });

  test("listResources 分页遍历所有文档", async () => {
    const fetchSpy = mock()
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 120,
            docs: Array.from({ length: 50 }, (_, i) => ({
              id: `doc_${i}`,
              name: `f${i}.pdf`,
              run: "DONE",
            })),
          },
        }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 120,
            docs: Array.from({ length: 50 }, (_, i) => ({
              id: `doc_${i + 50}`,
              name: `f${i + 50}.pdf`,
              run: "DONE",
            })),
          },
        }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        json: async () => ({
          code: 0,
          data: {
            total: 120,
            docs: Array.from({ length: 20 }, (_, i) => ({
              id: `doc_${i + 100}`,
              name: `f${i + 100}.pdf`,
              run: "DONE",
            })),
          },
        }),
      }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const results = await provider.listResources({
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    expect(results).toHaveLength(120);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  test("deleteResource 传 knowledgeBaseRemoteId 拼接正确的 API 路径", async () => {
    const fetchSpy = mock(async () => ({
      ok: true,
      json: async () => ({ code: 0 }),
      text: async () => JSON.stringify({ code: 0 }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await provider.deleteResource({
      resourceRemoteId: "doc_xyz",
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    const url = (fetchSpy as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain("/api/v1/datasets/ds_abc123/documents/doc_xyz");
  });

  test("deleteResource 遇到旧路径 405 时回退到集合端点删除 document", async () => {
    const fetchSpy = mock(async (_url: string, init?: RequestInit) => {
      if (init?.body) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ code: 0 }),
        };
      }
      return {
        ok: false,
        status: 405,
        text: async () => JSON.stringify({ code: 100, message: "<MethodNotAllowed '405: Method Not Allowed'>" }),
      };
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await provider.deleteResource({
      resourceRemoteId: "doc_xyz",
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const fallbackUrl = (fetchSpy as ReturnType<typeof mock>).mock.calls[1][0] as string;
    const fallbackInit = (fetchSpy as ReturnType<typeof mock>).mock.calls[1][1] as RequestInit;
    expect(fallbackUrl).toBe("http://ragflow.test/api/v1/datasets/ds_abc123/documents");
    expect(fallbackInit.method).toBe("DELETE");
    expect(JSON.parse(fallbackInit.body as string)).toEqual({ ids: ["doc_xyz"] });
  });

  test("search 结果中 resourceId 使用 document_id（非 chunk_id）", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          chunks: [
            {
              content: "snippet text",
              document_name: "test.pdf",
              document_id: "doc_xyz",
              dataset_id: "ds_abc123",
              similarity: 0.95,
              chunk_id: "chk_999",
            },
          ],
        },
      }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const results = await provider.search({
      knowledgeBases: [{ remoteId: "ds_abc123", remoteAccountId: "u1", remoteUserId: "u1" }],
      query: "test query",
      topK: 5,
    });

    expect(results).toHaveLength(1);
    expect(results[0].resourceId).toBe("doc_xyz");
    expect(results[0].knowledgeBaseId).toBe("ds_abc123");
    expect(results[0].resourceId).not.toBe("chk_999");
  });

  test("readResource 传 knowledgeBaseRemoteId 拼接正确的 API 路径并拼接 chunk 内容", async () => {
    const fetchSpy = mock(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          doc: { name: "test.pdf" },
          chunks: [{ content: "first chunk" }, { content: "second chunk" }],
        },
      }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const result = await provider.readResource({
      resourceRemoteId: "doc_xyz",
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    const url = (fetchSpy as unknown as { mock: { calls: string[][] } }).mock.calls[0][0];
    expect(url).toContain("/api/v1/datasets/ds_abc123/documents/doc_xyz/chunks");
    expect(result.content).toBe("first chunk\n\nsecond chunk");
    expect(result.title).toBe("test.pdf");
  });

  test("checkRagFlowHealth 使用 system healthz 端点且不携带 Authorization", async () => {
    const fetchSpy = mock(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok" }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const result = await checkRagFlowHealth();

    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect((fetchSpy as ReturnType<typeof mock>).mock.calls[0]?.[0]).toBe("http://ragflow.test/api/v1/system/healthz");
    expect(((fetchSpy as ReturnType<typeof mock>).mock.calls[0]?.[1] as RequestInit | undefined)?.headers).toEqual({
      "Content-Type": "application/json",
    });
  });

  // 验证数据集详情在不同 RagFlow 字段版本间保持一致的解析语义。
  test("getDataset 区分内置分块器、pipeline 并在请求失败时返回空值", async () => {
    const fetchSpy = mock()
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: { embedding_model: " embed@instance@provider ", parser_id: "naive", chunk_method: "book" },
          }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { parser_id: "pipeline_1" } }),
      }))
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ code: 503, message: "unavailable" }),
      }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(provider.getDataset({ datasetId: "builtin" })).resolves.toEqual({
      embeddingModel: "embed@instance@provider",
      chunkMethod: "naive",
      parseMethod: "builtin",
    });
    await expect(provider.getDataset({ datasetId: "pipeline" })).resolves.toEqual({
      embeddingModel: null,
      chunkMethod: "pipeline_1",
      parseMethod: "pipeline",
    });
    await expect(provider.getDataset({ datasetId: "unavailable" })).resolves.toBeNull();
  });

  // 验证厂商目录会过滤无效项，并统一对象和字符串形式的官网地址。
  test("listFactories 映射可用厂商并在上游异常时降级为空数组", async () => {
    const fetchSpy = mock()
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: [
              { name: "Qwen", tags: "embedding", url: { default: "https://example.test/qwen" } },
              { name: "Local", url: "https://example.test/local" },
              { name: "  " },
              {},
            ],
          }),
      }))
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 500,
        text: async () => JSON.stringify({ code: 500, message: "failed" }),
      }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(provider.listFactories()).resolves.toEqual([
      { name: "Qwen", tags: "embedding", url: "https://example.test/qwen" },
      { name: "Local", tags: null, url: "https://example.test/local" },
    ]);
    await expect(provider.listFactories()).resolves.toEqual([]);
  });

  // 验证供应商连接检查仅报告错误摘要，不向调用方抛出上游异常。
  test("verifyProviderConnection 编码厂商路径并返回验证结果", async () => {
    const fetchSpy = mock()
      .mockImplementationOnce(async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: 0 }) }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 401, message: "invalid provider key" }),
      }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.verifyProviderConnection({
        provider: "Vendor / One",
        providerApiKey: "provider-key",
        baseUrl: " https://provider.test ",
      }),
    ).resolves.toEqual({ success: true });
    await expect(provider.verifyProviderConnection({ provider: "Vendor", providerApiKey: "invalid" })).resolves.toEqual(
      { success: false, message: "code=401: invalid provider key" },
    );

    expect((fetchSpy as ReturnType<typeof mock>).mock.calls[0]?.[0]).toContain("Vendor%20%2F%20One/connection");
    const request = (fetchSpy as ReturnType<typeof mock>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toEqual({ api_key: "provider-key", base_url: "https://provider.test" });
  });

  // 验证实例模型管理仅展示嵌入模型，并保留模型启用状态。
  test("listInstanceModels 过滤非 embedding 模型并映射实例状态", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 0,
          data: [
            { name: "embed-1", model_type: ["chat", "embedding"], max_tokens: 8192, status: "inactive" },
            { name: "chat-1", model_type: "chat" },
            { model_type: "embedding" },
          ],
        }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(provider.listInstanceModels({ provider: "Qwen", instanceName: "main" })).resolves.toEqual([
      {
        name: "embed-1",
        provider: "Qwen",
        instance: "main",
        modelType: "chat,embedding",
        maxTokens: 8192,
        status: "inactive",
      },
    ]);
  });

  // 验证模型列表兼容新旧 RagFlow 接口，并排除不匹配类型和无效记录。
  test("listEmbeddingModels 与 listRerankModels 兼容新旧模型响应", async () => {
    const fetchSpy = mock()
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            code: 0,
            data: [
              { name: "embed", provider_name: "Qwen", instance_name: "tenant", model_type: ["embedding"] },
              { name: "chat", model_type: ["chat"] },
              null,
            ],
          }),
      }))
      .mockImplementationOnce(async () => ({
        ok: false,
        status: 404,
        text: async () => JSON.stringify({ code: 404, message: "not found" }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ code: 0, data: [{ llm_name: "rerank-v1", name: "Legacy", model_type: "rerank" }] }),
      }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(provider.listEmbeddingModels()).resolves.toEqual([
      { name: "embed@tenant@Qwen", label: "tenant › embed", provider: "Qwen", instance: "tenant" },
    ]);
    await expect(provider.listRerankModels()).resolves.toEqual([
      { name: "rerank-v1@Legacy", label: "Legacy · rerank-v1", provider: "Legacy", instance: "" },
    ]);
  });

  // 验证检索请求只透传已启用的可选参数，并把缺省字段映射为稳定结果。
  test("search 构造可选检索参数并映射结果回退字段", async () => {
    const fetchSpy = mock(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 0,
          data: {
            chunks: [
              { content: "answer", id: "chunk-1" },
              { content: "other", document_keyword: "keyword", similarity: 0.8 },
            ],
          },
        }),
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const result = await provider.search({
      knowledgeBases: [{ remoteId: "dataset-1", remoteAccountId: "account", remoteUserId: "user" }],
      query: "question",
      topK: 3,
      similarityThreshold: 0.6,
      keyword: false,
      highlight: true,
      crossLanguages: ["en", "zh"],
      metaDataFilter: { method: "manual", logic: "and", manual: [] },
    });

    expect(result).toEqual([
      { title: "chunk-1", snippet: "answer", source: "chunk-1", score: 0, knowledgeBaseId: null, resourceId: null },
      { title: "keyword", snippet: "other", source: "keyword", score: 0.8, knowledgeBaseId: null, resourceId: null },
    ]);
    const request = (fetchSpy as ReturnType<typeof mock>).mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(request.body as string)).toMatchObject({
      question: "question",
      dataset_ids: ["dataset-1"],
      top_k: 3,
      similarity_threshold: 0.6,
      keyword: false,
      highlight: true,
      cross_languages: ["en", "zh"],
      meta_data_filter: { method: "manual", logic: "and", manual: [] },
    });
  });

  // 验证切片列表保留分页位置、可用状态和关键词数组的防御性默认值。
  test("listChunks 映射切片分页数据并清理空关键词", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          code: 0,
          data: {
            total: 5,
            chunks: [
              { id: "chunk-1", content: "first", important_keywords: ["one"], available_int: 0 },
              { id: "chunk-2", content: "second", available_int: 1 },
            ],
          },
        }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.listChunks({
        knowledgeBaseRemoteId: "dataset",
        resourceRemoteId: "document",
        remoteAccountId: "account",
        remoteUserId: "user",
        page: 2,
        pageSize: 2,
        keyword: " useful ",
      }),
    ).resolves.toEqual({
      items: [
        { id: "chunk-1", content: "first", chunkIndex: 3, importantKeywords: ["one"], enabled: false },
        { id: "chunk-2", content: "second", chunkIndex: 4, importantKeywords: [], enabled: true },
      ],
      total: 5,
      page: 2,
      pageSize: 2,
    });
  });

  // 验证知识图谱删除将“图不存在”作为幂等成功，其余上游错误仍会传播。
  test("deleteKnowledgeGraph 仅忽略图不存在错误", async () => {
    const fetchSpy = mock()
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 102, message: "graph not found" }),
      }))
      .mockImplementationOnce(async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 500, message: "failed" }),
      }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await expect(
      provider.deleteKnowledgeGraph({
        knowledgeBaseRemoteId: "dataset",
        remoteAccountId: "account",
        remoteUserId: "user",
      }),
    ).resolves.toBeUndefined();
    await expect(
      provider.deleteKnowledgeGraph({
        knowledgeBaseRemoteId: "dataset",
        remoteAccountId: "account",
        remoteUserId: "user",
      }),
    ).rejects.toThrow("code=500: failed");
  });
});
