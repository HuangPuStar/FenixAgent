import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  loadKnowledgeBaseDetailData,
  loadKnowledgeBasesData,
  summarizeKnowledgeDetail,
  uploadKnowledgeBaseFiles,
} from "../pages/KnowledgeBasesPage";
import type { KnowledgeBaseDetail } from "../types/knowledge";

// Mock localStorage
beforeEach(() => {
  (globalThis as any).localStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
    get length() {
      return 0;
    },
    key: () => null,
  };
});

describe("KnowledgeBasesPage helpers", () => {
  // 测试加载知识库列表
  test("loadKnowledgeBasesData fetches and returns knowledge bases", async () => {
    const mockData = [
      {
        id: "kb_1",
        name: "项目文档",
        slug: "project-docs",
        description: null,
        provider: "openviking",
        remoteId: "remote-1",
        status: "ready",
        lastError: null,
        bindingsCount: 2,
        resourcesCount: 3,
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockData), { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    ) as unknown as typeof fetch;

    try {
      const result = await loadKnowledgeBasesData();
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe("项目文档");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // 测试加载知识库详情和资源
  test("loadKnowledgeBaseDetailData fetches detail and resources", async () => {
    const detailData = {
      id: "kb_1",
      name: "项目文档",
      slug: "project-docs",
      description: "docs",
      provider: "openviking",
      remoteId: "remote-1",
      status: "error",
      lastError: "索引失败",
      bindingsCount: 1,
      resourcesCount: 2,
      recentResources: [],
      createdAt: 1,
      updatedAt: 2,
    };
    const resourcesData = [
      {
        id: "res_1",
        knowledgeBaseId: "kb_1",
        sourceName: "spec.md",
        sourceType: "upload",
        sourcePath: "/tmp/spec.md",
        remoteId: "remote-res-1",
        status: "error",
        lastError: "索引失败",
        createdAt: 1,
        updatedAt: 2,
      },
    ];

    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => {
      callCount++;
      const body = callCount === 1 ? detailData : resourcesData;
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    }) as unknown as typeof fetch;

    try {
      const data = await loadKnowledgeBaseDetailData("kb_1");
      expect(data.detail.lastError).toBe("索引失败");
      expect(data.resources[0].sourceName).toBe("spec.md");
      expect(summarizeKnowledgeDetail(data.detail as unknown as KnowledgeBaseDetail, data.resources)).toEqual({
        lastError: "索引失败",
        resourcesCount: 1,
        resourceNames: ["spec.md"],
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // 测试上传知识库文件
  test("uploadKnowledgeBaseFiles uploads files via fetchUpload", async () => {
    const mockResponse = {
      items: [
        {
          id: "res_0",
          knowledgeBaseId: "kb_1",
          sourceName: "a.md",
          sourceType: "upload",
          sourcePath: null,
          remoteId: null,
          status: "processing",
          lastError: null,
          createdAt: 1,
          updatedAt: 1,
        },
        {
          id: "res_1",
          knowledgeBaseId: "kb_1",
          sourceName: "b.md",
          sourceType: "upload",
          sourcePath: null,
          remoteId: null,
          status: "processing",
          lastError: null,
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(mockResponse), { status: 200, headers: { "Content-Type": "application/json" } }),
      ),
    ) as unknown as typeof fetch;

    try {
      const files = [
        new File(["a"], "a.md", { type: "text/markdown" }),
        new File(["b"], "b.md", { type: "text/markdown" }),
      ];
      const result = await uploadKnowledgeBaseFiles("kb_1", files);
      expect(result.items.map((item) => item.sourceName)).toEqual(["a.md", "b.md"]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
