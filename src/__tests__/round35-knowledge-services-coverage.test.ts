import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import {
  agentKnowledgeBindingRepo,
  type KnowledgeBaseRow,
  type KnowledgeResourceRow,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../repositories/knowledge-base";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";
import {
  deleteKnowledgeGraphForKb,
  generateKnowledgeGraphForKb,
  getKnowledgeGraphForAgent,
  getKnowledgeGraphForKb,
  pollKnowledgeGraphProgressForKb,
  readKnowledgeResourceForAgent,
  searchKnowledgeForTest,
  setKnowledgeRuntimeProviderForTesting,
} from "../services/knowledge-runtime";
import {
  deleteKnowledgeResource,
  importKnowledgeResourceFromUrl,
  listKnowledgeResources,
  refreshKnowledgeResourceStatus,
  setKnowledgeUploadProviderForTesting,
} from "../services/knowledge-upload";
import { resetAllStubs } from "../test-utils/helpers";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function kb(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "owner-1",
    organizationId: "org-1",
    name: "产品文档",
    slug: "product-docs",
    description: null,
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: "account-1",
    remoteUserId: "remote-user-1",
    metadata: null,
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function resource(overrides: Partial<KnowledgeResourceRow> = {}): KnowledgeResourceRow {
  return {
    id: "resource-1",
    knowledgeBaseId: "kb-1",
    sourceType: "url",
    sourceName: "guide.md",
    sourcePath: "https://docs.example.test/guide.md",
    remoteId: "remote-resource-1",
    status: "ready",
    lastError: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

class ServiceProvider extends RagFlowKnowledgeProvider {
  addInputs: Parameters<RagFlowKnowledgeProvider["addResource"]>[0][] = [];
  deleteInputs: Parameters<RagFlowKnowledgeProvider["deleteResource"]>[0][] = [];
  graphInputs: Record<string, unknown>[] = [];
  remoteResources: Awaited<ReturnType<RagFlowKnowledgeProvider["listResources"]>> = [];
  addFailure: Error | null = null;
  deleteFailure: Error | null = null;
  listFailure: Error | null = null;
  graphFailure: Error | null = null;

  override async addResource(input: Parameters<RagFlowKnowledgeProvider["addResource"]>[0]) {
    this.addInputs.push(input);
    if (this.addFailure) throw this.addFailure;
    return {
      remoteId: `remote-${input.sourceName ?? "resource"}`,
      knowledgeBaseRemoteId: input.knowledgeBaseRemoteId,
      sourceName: input.sourceName ?? "resource",
      sourceType: input.url ? "url" : "upload",
      status: "ready" as const,
    };
  }

  override async deleteResource(input: Parameters<RagFlowKnowledgeProvider["deleteResource"]>[0]) {
    this.deleteInputs.push(input);
    if (this.deleteFailure) throw this.deleteFailure;
  }

  override async listResources(input: Parameters<RagFlowKnowledgeProvider["listResources"]>[0]) {
    if (this.listFailure) throw this.listFailure;
    return this.remoteResources.map((item) => ({ ...item, knowledgeBaseRemoteId: input.knowledgeBaseRemoteId }));
  }

  override async searchDetailed() {
    return { chunks: [], total: 0, docAggs: [] };
  }

  override async readResource() {
    return { content: "正文", sourceName: "guide.md", sourceType: "url" };
  }

  override async generateKnowledgeGraph(input: Parameters<RagFlowKnowledgeProvider["generateKnowledgeGraph"]>[0]) {
    this.graphInputs.push(input);
    if (this.graphFailure) throw this.graphFailure;
  }

  override async getKnowledgeGraph(input: Parameters<RagFlowKnowledgeProvider["getKnowledgeGraph"]>[0]) {
    this.graphInputs.push(input);
    if (this.graphFailure) throw this.graphFailure;
    return { graph: { nodes: [{ id: "node-1", label: "节点", type: "entity" }], edges: [] } };
  }

  override async deleteKnowledgeGraph(input: Parameters<RagFlowKnowledgeProvider["deleteKnowledgeGraph"]>[0]) {
    this.graphInputs.push(input);
    if (this.graphFailure) throw this.graphFailure;
  }

  override async pollKnowledgeGraphProgress(
    input: Parameters<RagFlowKnowledgeProvider["pollKnowledgeGraphProgress"]>[0],
  ) {
    this.graphInputs.push(input);
    if (this.graphFailure) throw this.graphFailure;
    return { progress: 0.75, progressMsg: "构图中", taskId: "task-1" };
  }
}

const originals = {
  getBase: knowledgeBaseRepo.getById,
  updateBase: knowledgeBaseRepo.update,
  getResource: knowledgeResourceRepo.getById,
  getBySourceName: knowledgeResourceRepo.getBySourceName,
  createResource: knowledgeResourceRepo.create,
  updateResource: knowledgeResourceRepo.update,
  deleteResource: knowledgeResourceRepo.delete,
  listResources: knowledgeResourceRepo.listByKnowledgeBase,
  getSummary: knowledgeResourceRepo.getStatusSummary,
  findResources: knowledgeResourceRepo.findByRemoteIds,
  getResourceWithKb: agentKnowledgeBindingRepo.getResourceWithKnowledgeBase,
  joinedBindings: agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId,
};

function installResourceStore(rows: KnowledgeResourceRow[]) {
  knowledgeBaseRepo.update = mock(async () => undefined);
  knowledgeResourceRepo.getById = mock(async (id) => rows.find((row) => row.id === id) ?? null);
  knowledgeResourceRepo.getBySourceName = mock(
    async (knowledgeBaseId, sourceName) =>
      rows.find((row) => row.knowledgeBaseId === knowledgeBaseId && row.sourceName === sourceName) ?? null,
  );
  knowledgeResourceRepo.create = mock(async (input) => {
    const created = resource({ ...input, id: input.id ?? `resource-${rows.length + 1}` });
    rows.push(created);
    return created;
  });
  knowledgeResourceRepo.update = mock(async (id, patch) => {
    const row = rows.find((item) => item.id === id);
    if (row) Object.assign(row, patch);
  });
  knowledgeResourceRepo.delete = mock(async (id) => {
    const index = rows.findIndex((row) => row.id === id);
    if (index >= 0) rows.splice(index, 1);
    return index >= 0;
  });
  knowledgeResourceRepo.listByKnowledgeBase = mock(async (knowledgeBaseId) =>
    rows.filter((row) => row.knowledgeBaseId === knowledgeBaseId),
  );
  knowledgeResourceRepo.getStatusSummary = mock(async () => ({
    readyCount: 1,
    activeCount: 0,
    errorCount: 0,
    totalCount: rows.length,
  }));
}

function boundRow(id = "kb-1", remoteId = "remote-kb-1") {
  return {
    id: `binding-${id}`,
    agentConfigId: "agent-1",
    knowledgeBaseId: id,
    config: null,
    priority: 1,
    enabled: true,
    createdAt: NOW,
    updatedAt: NOW,
    kbId: id,
    kbName: `知识库-${id}`,
    kbRemoteId: remoteId,
    kbRemoteAccountId: "account-1",
    kbRemoteUserId: "user-1",
    kbUserId: "owner-1",
    kbOrganizationId: "org-1",
    kbEmbeddingModel: null,
  };
}

describe("第35轮知识服务真实业务边界", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
  });

  afterEach(() => {
    knowledgeBaseRepo.getById = originals.getBase;
    knowledgeBaseRepo.update = originals.updateBase;
    knowledgeResourceRepo.getById = originals.getResource;
    knowledgeResourceRepo.getBySourceName = originals.getBySourceName;
    knowledgeResourceRepo.create = originals.createResource;
    knowledgeResourceRepo.update = originals.updateResource;
    knowledgeResourceRepo.delete = originals.deleteResource;
    knowledgeResourceRepo.listByKnowledgeBase = originals.listResources;
    knowledgeResourceRepo.getStatusSummary = originals.getSummary;
    knowledgeResourceRepo.findByRemoteIds = originals.findResources;
    agentKnowledgeBindingRepo.getResourceWithKnowledgeBase = originals.getResourceWithKb;
    agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId = originals.joinedBindings;
    setKnowledgeUploadProviderForTesting(null);
    setKnowledgeRuntimeProviderForTesting(null);
    resetConfig();
    resetAllStubs();
  });

  test.each([
    ["显式名称", "https://docs.example.test/a.pdf", " 自定义名称 ", "自定义名称"],
    ["路径文件名", "https://docs.example.test/guide.md", undefined, "guide.md"],
    ["根路径回退", "https://docs.example.test/", undefined, "https://docs.example.test/"],
    ["带查询参数", "https://docs.example.test/api.json?version=2", undefined, "api.json"],
    ["中文路径", "https://docs.example.test/手册.pdf", undefined, "%E6%89%8B%E5%86%8C.pdf"],
    ["多点扩展名", "https://docs.example.test/archive.tar.gz", undefined, "archive.tar.gz"],
    ["空白名称回退", "https://docs.example.test/blank.txt", "   ", "blank.txt"],
    ["深层路径", "https://docs.example.test/a/b/c/readme", undefined, "readme"],
    ["末尾斜杠", "https://docs.example.test/docs/", undefined, "docs"],
    ["编码路径", "https://docs.example.test/a%20b.txt", undefined, "a%20b.txt"],
    ["大写扩展名", "https://docs.example.test/Guide.PDF", undefined, "Guide.PDF"],
    ["短文件名", "https://docs.example.test/x", undefined, "x"],
    ["数字文件名", "https://docs.example.test/2026", undefined, "2026"],
    ["连字符名称", "https://docs.example.test/api-reference.md", undefined, "api-reference.md"],
    ["下划线名称", "https://docs.example.test/api_reference.md", undefined, "api_reference.md"],
    ["点号名称", "https://docs.example.test/.well-known", undefined, ".well-known"],
    ["带端口地址", "https://docs.example.test:8443/port.md", undefined, "port.md"],
    ["国际化名称", "https://docs.example.test/知识/部署.md", undefined, "%E9%83%A8%E7%BD%B2.md"],
    ["自定义名称保留空格裁剪", "https://docs.example.test/name.md", " 名称.md ", "名称.md"],
    ["无扩展名", "https://docs.example.test/license", undefined, "license"],
    ["版本化文档", "https://docs.example.test/v1/guide.md", undefined, "guide.md"],
    ["锚点文档", "https://docs.example.test/guide.md#install", undefined, "guide.md"],
    ["多个查询参数", "https://docs.example.test/search.json?a=1&b=2", undefined, "search.json"],
    ["重复分隔符", "https://docs.example.test/a//b.md", undefined, "b.md"],
    ["隐藏扩展名", "https://docs.example.test/.config.json", undefined, ".config.json"],
    ["末尾点号", "https://docs.example.test/readme.", undefined, "readme."],
  ])("导入 URL 资源使用%s生成稳定 DTO", async (_caseName, url, sourceName, expectedName) => {
    const provider = new ServiceProvider();
    const rows: KnowledgeResourceRow[] = [];
    installResourceStore(rows);
    knowledgeBaseRepo.getById = mock(async () => kb());
    setKnowledgeUploadProviderForTesting(provider);

    const result = await importKnowledgeResourceFromUrl("org-1", "kb-1", { url, sourceName }, "user-1");

    expect(result).toMatchObject({
      knowledgeBaseId: "kb-1",
      sourceType: "url",
      sourceName: expectedName,
      status: "ready",
    });
    expect(provider.addInputs[0]).toMatchObject({
      url,
      sourceName,
      knowledgeBaseRemoteId: "remote-kb-1",
      apiKey: "test-ragflow-key",
    });
  });

  test.each([
    ["远端资源不存在", "Document not found"],
    ["HTTP 404", "HTTP 404 from provider"],
    ["not found", "not found"],
    ["not exist", "document not exist"],
    ["nonexistent", "nonexistent resource"],
  ])("删除资源在%s时保持本地幂等", async (_caseName, message) => {
    const provider = new ServiceProvider();
    provider.deleteFailure = new Error(message);
    const rows = [resource()];
    installResourceStore(rows);
    knowledgeBaseRepo.getById = mock(async () => kb());
    setKnowledgeUploadProviderForTesting(provider);

    await expect(deleteKnowledgeResource("org-1", "kb-1", "resource-1", "user-1")).resolves.toEqual({
      success: true,
      data: null,
    });
    expect(rows).toEqual([]);
  });

  test.each([
    ["provider 连接失败", "provider unavailable"],
    ["认证失败", "unauthorized"],
    ["超时失败", "timeout"],
    ["服务错误", "HTTP 500"],
    ["非 Error 失败", "upstream broken"],
  ])("导入 URL 在%s时记录资源错误 DTO", async (_caseName, message) => {
    const provider = new ServiceProvider();
    provider.addFailure = new Error(message);
    const rows: KnowledgeResourceRow[] = [];
    installResourceStore(rows);
    knowledgeBaseRepo.getById = mock(async () => kb());
    setKnowledgeUploadProviderForTesting(provider);

    const result = await importKnowledgeResourceFromUrl(
      "org-1",
      "kb-1",
      { url: "https://docs.example.test/fail.md" },
      "user-1",
    );

    expect(result).toMatchObject({ sourceName: "fail.md", status: "error", lastError: message, remoteId: null });
  });

  test.each([
    ["未同步远端资源", null],
    ["空资源列表", []],
    ["单个本地资源", [resource({ sourcePath: null, remoteId: null })]],
    ["错误状态资源", [resource({ status: "error", lastError: "解析失败" })]],
    ["处理中资源", [resource({ status: "processing" })]],
    ["上传来源资源", [resource({ sourceType: "upload", sourceName: "manual.pdf" })]],
    ["多个资源", [resource(), resource({ id: "resource-2", sourceName: "api.md" })]],
    ["空 sourcePath", [resource({ sourcePath: null })]],
    ["空 remoteId", [resource({ remoteId: null })]],
    ["时间秒级 DTO", [resource({ createdAt: new Date("2026-01-01T00:00:00.999Z") })]],
  ])("列表资源对%s返回隔离后的 DTO", async (_caseName, rowsOrRemoteId) => {
    const provider = new ServiceProvider();
    const rows = Array.isArray(rowsOrRemoteId) ? rowsOrRemoteId : [resource()];
    installResourceStore(rows);
    knowledgeBaseRepo.getById = mock(async () => kb({ remoteId: rowsOrRemoteId === null ? null : "remote-kb-1" }));
    setKnowledgeUploadProviderForTesting(provider);

    const result = await listKnowledgeResources("org-1", "kb-1", "user-1");

    expect(result).toHaveLength(rows.length);
    expect(result?.every((item) => item.knowledgeBaseId === "kb-1")).toBe(true);
  });

  test.each([
    ["远端新增 URL 资源", "url", "remote-new-url"],
    ["远端新增上传资源", "upload", "remote-new-upload"],
    ["远端新增处理资源", "upload", "remote-processing"],
    ["远端新增错误资源", "url", "remote-error"],
    ["远端同步已知资源", "url", "remote-resource-1"],
    ["远端同步多个资源", "url", "remote-second"],
    ["远端资源含来源地址", "url", "remote-with-source"],
    ["远端资源无来源地址", "upload", "remote-no-source"],
    ["远端资源含错误信息", "url", "remote-error-detail"],
    ["远端资源状态就绪", "upload", "remote-ready"],
  ])("刷新资源将%s合并为本地资源", async (_caseName, sourceType, remoteId) => {
    const provider = new ServiceProvider();
    provider.remoteResources = [
      {
        remoteId,
        sourceName: `${remoteId}.md`,
        sourceType,
        source: sourceType === "url" ? `https://docs.example.test/${remoteId}` : null,
        status: remoteId.includes("processing") ? "processing" : remoteId.includes("error") ? "error" : "ready",
        lastError: remoteId.includes("error") ? "远端错误" : null,
      },
    ];
    const rows = remoteId === "remote-resource-1" ? [resource()] : [];
    installResourceStore(rows);
    knowledgeBaseRepo.getById = mock(async () => kb());
    setKnowledgeUploadProviderForTesting(provider);

    const result = await refreshKnowledgeResourceStatus("org-1", "kb-1", "user-1");

    expect(result?.some((item) => item.remoteId === remoteId)).toBe(true);
    expect(rows.some((item) => item.remoteId === remoteId)).toBe(true);
  });

  test.each([
    ["生成", generateKnowledgeGraphForKb],
    ["读取", getKnowledgeGraphForKb],
    ["删除", deleteKnowledgeGraphForKb],
    ["轮询", pollKnowledgeGraphProgressForKb],
  ])("图谱%s使用远端身份和组织范围", async (_caseName, action) => {
    const provider = new ServiceProvider();
    knowledgeBaseRepo.getById = mock(async () => kb({ remoteAccountId: " account ", remoteUserId: " user " }));
    setKnowledgeRuntimeProviderForTesting(provider);

    await action({ organizationId: "org-1", knowledgeBaseId: "kb-1", userId: "user-1" });

    expect(provider.graphInputs[0]).toMatchObject({
      knowledgeBaseRemoteId: "remote-kb-1",
      remoteAccountId: "account",
      remoteUserId: "user",
      apiKey: "test-ragflow-key",
    });
  });

  test.each([
    ["图谱生成", generateKnowledgeGraphForKb],
    ["图谱读取", getKnowledgeGraphForKb],
    ["图谱删除", deleteKnowledgeGraphForKb],
    ["图谱轮询", pollKnowledgeGraphProgressForKb],
  ])("%s拒绝不存在知识库", async (_caseName, action) => {
    knowledgeBaseRepo.getById = mock(async () => null);
    setKnowledgeRuntimeProviderForTesting(new ServiceProvider());

    await expect(action({ organizationId: "org-1", knowledgeBaseId: "missing", userId: "user-1" })).rejects.toThrow(
      "Knowledge base not found",
    );
  });

  test.each([
    ["图谱生成", generateKnowledgeGraphForKb],
    ["图谱读取", getKnowledgeGraphForKb],
    ["图谱删除", deleteKnowledgeGraphForKb],
    ["图谱轮询", pollKnowledgeGraphProgressForKb],
  ])("%s拒绝缺失远端 ID", async (_caseName, action) => {
    knowledgeBaseRepo.getById = mock(async () => kb({ remoteId: null }));
    setKnowledgeRuntimeProviderForTesting(new ServiceProvider());

    await expect(action({ organizationId: "org-1", knowledgeBaseId: "kb-1", userId: "user-1" })).rejects.toThrow(
      "Knowledge base remote id is missing",
    );
  });

  test.each([
    ["指定已绑定知识库", "kb-1", true],
    ["指定未绑定知识库", "kb-other", false],
    ["未指定时选择首个图谱", undefined, true],
    ["不同组织仍按绑定返回", "kb-1", true],
  ])("Agent 图谱%s遵守绑定边界", async (_caseName, knowledgeBaseId, allowed) => {
    const provider = new ServiceProvider();
    agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId = mock(async () => [boundRow()]);
    setKnowledgeRuntimeProviderForTesting(provider);

    const call = getKnowledgeGraphForAgent({ agentConfigId: "agent-1", organizationId: "org-1", knowledgeBaseId });
    if (allowed) {
      await expect(call).resolves.toMatchObject({ knowledgeBaseId: "kb-1", graph: { nodes: [{ id: "node-1" }] } });
    } else {
      await expect(call).rejects.toThrow("is not bound to this agent");
    }
  });

  test.each([
    ["缺失资源", null, "Knowledge resource not found"],
    ["缺失远端 ID", { remoteId: null }, "Knowledge resource remote id is missing"],
    ["用户不匹配", { remoteId: "remote-resource-1", kbUserId: "other-user" }, "Knowledge resource not accessible"],
    ["未绑定 Agent", { remoteId: "remote-resource-1" }, "Knowledge resource is not bound to the agent"],
  ])("读取资源在%s时阻断越权访问", async (_caseName, override, expectedMessage) => {
    const base = {
      resource: resource({ remoteId: "remote-resource-1" }),
      kbUserId: "owner-1",
      kbOrganizationId: "org-1",
      kbRemoteId: "remote-kb-1",
      kbRemoteAccountId: "account-1",
      kbRemoteUserId: "user-1",
    };
    agentKnowledgeBindingRepo.getResourceWithKnowledgeBase = mock(async () =>
      override === null
        ? null
        : {
            ...base,
            ...override,
            resource: { ...base.resource, ...(override.remoteId === null ? { remoteId: null } : {}) },
          },
    );
    agentKnowledgeBindingRepo.listJoinedWithKnowledgeBaseByConfigId = mock(async () => []);
    setKnowledgeRuntimeProviderForTesting(new ServiceProvider());

    await expect(
      readKnowledgeResourceForAgent({
        agentConfigId: "agent-1",
        resourceId: "resource-1",
        userId: "owner-1",
        organizationId: "org-1",
      }),
    ).rejects.toThrow(expectedMessage);
  });

  test.each([
    ["默认身份", "account-1", "user-1"],
    ["空白账号回退", "   ", "user-1"],
    ["空白用户回退", "account-1", "   "],
    ["双空白回退", " ", " "],
  ])("切片检索 DTO 对%s规范化远端身份", async (_caseName, remoteAccountId, remoteUserId) => {
    const provider = new ServiceProvider();
    knowledgeBaseRepo.getById = mock(async () => kb({ remoteAccountId, remoteUserId }));
    setKnowledgeRuntimeProviderForTesting(provider);

    await expect(
      searchKnowledgeForTest({
        organizationId: "org-1",
        knowledgeBaseId: "kb-1",
        query: "切片",
        topK: 2,
        page: 1,
        pageSize: 20,
      }),
    ).resolves.toEqual({ chunks: [], total: 0, docAggs: [] });
  });
});
