import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetConfig, setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { type KnowledgeBaseRow, knowledgeBaseRepo } from "../repositories/knowledge-base";
import webKnowledgeBasesRoute from "../routes/web/knowledge-bases";
import { RagFlowKnowledgeProvider } from "../services/knowledge-provider/ragflow";
import { setKnowledgeProviderForTesting } from "../services/knowledge-provider/registry";
import { resetAllStubs } from "../test-utils/helpers";

const NOW = new Date("2026-08-19T00:00:00.000Z");

function kb(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "文档",
    slug: "docs",
    description: null,
    provider: "ragflow",
    remoteId: "remote-1",
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

function request(path: string, init?: RequestInit) {
  return webKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

function post(path: string, body: Record<string, unknown>) {
  return request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

class KnowledgeRouteProvider extends RagFlowKnowledgeProvider {
  override async listDatasets() {
    return [
      { id: "remote-1", name: "已关联" },
      { id: "remote-2", name: "待导入" },
    ];
  }

  override async listEmbeddingModels() {
    return [{ name: "embed", label: "Embed", provider: "OpenAI", instance: "default" }];
  }

  override async listPipelines() {
    return [{ id: "pipeline-1", name: "默认流水线" }];
  }

  override async listRerankModels() {
    return [{ name: "rerank", label: "Rerank", provider: "OpenAI", instance: "default" }];
  }
}

const originalListByOrganizationId = knowledgeBaseRepo.listByOrganizationId;

describe("知识库最大缺口路由的隔离分支", () => {
  beforeEach(() => {
    resetAllStubs();
    setConfig({ ragflowApiKey: "test-ragflow-key" });
    setTestAuth({
      user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setKnowledgeProviderForTesting(new KnowledgeRouteProvider());
  });

  afterEach(() => {
    knowledgeBaseRepo.listByOrganizationId = originalListByOrganizationId;
    setKnowledgeProviderForTesting(null);
    resetConfig();
    resetTestAuth();
    resetAllStubs();
  });

  // 未关联列表只能排除当前组织已绑定的远端知识库。
  test("未关联列表按当前组织过滤远端 ID", async () => {
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [kb()]);
    const response = await post("/knowledgeBases", { action: "list-unassociated" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: [{ id: "remote-2", name: "待导入" }] });
  });

  // 上游目录失败应映射为网关错误，不能伪造空数据掩盖故障。
  test("未关联列表映射上游异常", async () => {
    const provider = new KnowledgeRouteProvider();
    provider.listDatasets = mock(async () => {
      throw new Error("upstream unavailable");
    });
    setKnowledgeProviderForTesting(provider);
    const response = await post("/knowledgeBases", { action: "list-unassociated" });
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "KNOWLEDGE_PROVIDER_ERROR" } });
  });

  // 表单选项应实际转发 provider 数据，并保留本地 chunk 方法。
  test("表单选项返回远端模型与流水线", async () => {
    const response = await request("/knowledgeBases/form-options");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        embeddingModels: [{ name: "embed" }],
        pipelines: [{ id: "pipeline-1" }],
        chunkMethods: expect.any(Array),
      },
    });
  });

  // rerank 列表是登录态能力，应返回 provider 的可选模型。
  test("rerank 模型路由返回 provider 结果", async () => {
    const response = await request("/knowledgeBases/rerank-models");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: [{ name: "rerank", label: "Rerank", provider: "OpenAI", instance: "default" }],
    });
  });

  // 缺少创建名称时必须在调用远端前拒绝请求。
  test("创建缺少名称返回验证错误", async () => {
    const response = await post("/knowledgeBases", {});
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR", message: "name is required" } });
  });

  // 导入动作缺少远端 ID 时不得写入当前组织记录。
  test("导入缺少远端 ID 返回验证错误", async () => {
    const create = mock(async () => kb());
    knowledgeBaseRepo.create = create;
    const response = await post("/knowledgeBases", { action: "import", name: "待导入" });
    expect(response.status).toBe(400);
    expect(create).not.toHaveBeenCalled();
  });
});
