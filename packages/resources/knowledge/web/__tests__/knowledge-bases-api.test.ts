import { beforeEach, describe, expect, mock, test } from "bun:test";

const fetchCalls: Array<[string, RequestInit]> = [];

beforeEach(() => {
  fetchCalls.length = 0;
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(
      new Response(JSON.stringify({ success: true, data: null }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
  }) as unknown as typeof fetch;
});

function expectRequest(index: number, url: string, method: string, body?: unknown) {
  const [actualUrl, init] = fetchCalls[index] ?? [];
  expect(actualUrl).toBe(url);
  expect(init?.method).toBe(method);
  expect(body === undefined ? init?.body : JSON.parse(init?.body as string)).toEqual(body);
}

describe("knowledge base API client", () => {
  // 知识库 CRUD、资源操作与检索必须映射到各自的 REST 路径、方法和 JSON 请求体。
  test("maps CRUD, resource and search calls to their REST contracts", async () => {
    const { kbApi } = await import("../api/knowledge-bases");

    await kbApi.list();
    await kbApi.get({ id: "kb/a" });
    await kbApi.create({ name: "Docs" });
    await kbApi.getFormOptions();
    await kbApi.update({ id: "kb/a" }, { description: "Updated" });
    await kbApi.del({ id: "kb/a" });
    await kbApi.importUrl({ id: "kb/a" }, { url: "https://example.test/doc" });
    await kbApi.listResources({ id: "kb/a" }, { page: 2, pageSize: 10 });
    await kbApi.deleteResource({ kbId: "kb/a", resourceId: "res/b" });
    await kbApi.toggleResourceEnabled({ kbId: "kb/a", resourceId: "res/b" }, { enabled: false });
    await kbApi.reparseResource({ kbId: "kb/a", resourceId: "res/b" }, { delete: true });
    await kbApi.listChunks({ kbId: "kb/a", resourceId: "res/b" }, { keyword: "hello", page: 1 });
    await kbApi.switchChunk({ kbId: "kb/a", resourceId: "res/b", chunkId: "chunk/c" }, { enabled: true });
    await kbApi.search({ id: "kb/a" }, { query: "What?" });

    expectRequest(0, "/web/knowledgeBases", "GET");
    expectRequest(1, "/web/knowledgeBases/kb%2Fa", "GET");
    expectRequest(2, "/web/knowledgeBases", "POST", { name: "Docs" });
    expectRequest(3, "/web/knowledgeBases/form-options", "GET");
    expectRequest(4, "/web/knowledgeBases/kb%2Fa", "PATCH", { description: "Updated" });
    expectRequest(5, "/web/knowledgeBases/kb%2Fa", "DELETE");
    expectRequest(6, "/web/knowledgeBases/kb%2Fa/resources/url", "POST", { url: "https://example.test/doc" });
    expectRequest(7, "/web/knowledgeBases/kb%2Fa/resources?page=2&pageSize=10", "GET");
    expectRequest(8, "/web/knowledgeBases/kb%2Fa/resources/res%2Fb", "DELETE");
    expectRequest(9, "/web/knowledgeBases/kb%2Fa/resources/res%2Fb/enabled", "PATCH", { enabled: false });
    expectRequest(10, "/web/knowledgeBases/kb%2Fa/resources/res%2Fb/reparse", "POST", { delete: true });
    expectRequest(11, "/web/knowledgeBases/kb%2Fa/resources/res%2Fb/chunks?keyword=hello&page=1", "GET");
    expectRequest(12, "/web/knowledgeBases/kb%2Fa/resources/res%2Fb/chunks/chunk%2Fc/enabled", "PATCH", {
      enabled: true,
    });
    expectRequest(13, "/web/knowledgeBases/kb%2Fa/search", "POST", { query: "What?" });
  });

  // 上传、导入、图谱和 URL 辅助函数要保留 query、FormData 与路径编码的协议细节。
  test("maps upload, import and graph operations without losing transport details", async () => {
    const { kbApi } = await import("../api/knowledge-bases");
    const formData = new FormData();
    formData.append("file", new File(["content"], "doc.txt"));

    await kbApi.uploadResources({ id: "kb/a", overwrite: true }, formData);
    await kbApi.listRerankModels();
    await kbApi.listUnassociated();
    await kbApi.import("remote-1", "Imported");
    await kbApi.generateGraph({ id: "kb/a" });
    await kbApi.getGraph({ id: "kb/a" });
    await kbApi.deleteGraph({ id: "kb/a" });
    await kbApi.getGraphProgress({ id: "kb/a" });

    expect(fetchCalls[0]?.[0]).toBe("/web/knowledgeBases/kb%2Fa/resources/upload?overwrite=true");
    expect(fetchCalls[0]?.[1].body).toBe(formData);
    expectRequest(1, "/web/knowledgeBases/rerank-models", "GET");
    expectRequest(2, "/web/knowledgeBases", "POST", { action: "list-unassociated" });
    expectRequest(3, "/web/knowledgeBases", "POST", { action: "import", remoteId: "remote-1", name: "Imported" });
    expectRequest(4, "/web/knowledgeBases/kb%2Fa/graph/generate", "POST");
    expectRequest(5, "/web/knowledgeBases/kb%2Fa/graph", "GET");
    expectRequest(6, "/web/knowledgeBases/kb%2Fa/graph", "DELETE");
    expectRequest(7, "/web/knowledgeBases/kb%2Fa/graph/progress", "GET");
    expect(kbApi.getFileUrl({ kbId: "kb/a", resourceId: "res/b" })).toBe(
      "/web/knowledgeBases/kb%2Fa/resources/res%2Fb/file",
    );
    expect(kbApi.getPdfUrl({ kbId: "kb/a", resourceId: "res/b" })).toBe(
      "/web/knowledgeBases/kb%2Fa/resources/res%2Fb/pdf",
    );
  });
});
