// src/__tests__/knowledge-provider-ragflow.test.ts
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";

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
  test("createKnowledgeBase 调用 RagFlow API 创建 dataset 并返回 dataset_id 作为 remoteId", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ code: 0, data: { id: "ds_abc123", name: "[org_user1] Test KB" } }),
    })) as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const result = await provider.createKnowledgeBase({
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

  test("deleteKnowledgeBase API 返回非 0 code 时抛出异常", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({ code: 102, message: "Dataset not found" }),
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

  test("addResource 上传文件并轮询解析状态直到 SUCCESS", async () => {
    const responses = [
      { ok: true, json: async () => ({ code: 0, data: [{ id: "doc_xyz" }] }) },
      { ok: true, json: async () => ({ code: 0 }) },
      { ok: true, json: async () => ({ code: 0, data: { docs: [{ id: "doc_xyz", run: { status: "RUNNING" } }] } }) },
      { ok: true, json: async () => ({ code: 0, data: { docs: [{ id: "doc_xyz", run: { status: "SUCCESS" } }] } }) },
    ];
    let callIndex = 0;
    const fetchSpy = mock(async () => {
      const res = responses[callIndex];
      callIndex += 1;
      return res;
    });
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    const result = await provider.addResource({
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
      filePath: "/tmp/test.pdf",
      sourceName: "test.pdf",
      wait: true,
    });

    expect(result.remoteId).toBe("doc_xyz");
    expect(result.status).toBe("ready");
    expect(result.knowledgeBaseRemoteId).toBe("ds_abc123");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
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

  test("addResource wait=false 跳过轮询直接返回 processing", async () => {
    const fetchSpy = mock(async (url: string) => {
      if (String(url).includes("/chunks")) {
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

  test("addResource 解析 FAIL 抛出异常", async () => {
    const fetchSpy = mock(async (url: string) => {
      const urlStr = String(url);
      if (urlStr.includes("/chunks")) {
        return { ok: true, json: async () => ({ code: 0 }) };
      }
      if (urlStr.includes("/documents") && !urlStr.includes("/chunks")) {
        return {
          ok: true,
          json: async () => ({
            code: 0,
            data: { docs: [{ id: "doc_fail", run: { status: "FAIL", message: "File corrupted" } }] },
          }),
        };
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
    ).rejects.toThrow("File corrupted");
  });

  test("listResources 正确映射 RagFlow run.status 到接口状态", async () => {
    globalThis.fetch = mock(async () => ({
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          total: 4,
          docs: [
            { id: "d1", name: "doc1.pdf", run: { status: "UNSTART" } },
            { id: "d2", name: "doc2.pdf", run: { status: "RUNNING" } },
            { id: "d3", name: "doc3.pdf", run: { status: "SUCCESS" } },
            { id: "d4", name: "doc4.pdf", run: { status: "FAIL", message: "error" } },
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
              run: { status: "SUCCESS" },
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
              run: { status: "SUCCESS" },
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
              run: { status: "SUCCESS" },
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
    }));
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const provider = new RagFlowKnowledgeProvider();
    await provider.deleteResource({
      resourceRemoteId: "doc_xyz",
      knowledgeBaseRemoteId: "ds_abc123",
      remoteAccountId: "user1",
      remoteUserId: "user1",
    });

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/datasets/ds_abc123/documents/doc_xyz");
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

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/datasets/ds_abc123/documents/doc_xyz/chunks");
    expect(result.content).toBe("first chunk\n\nsecond chunk");
    expect(result.title).toBe("test.pdf");
  });
});
