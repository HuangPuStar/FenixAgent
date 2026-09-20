import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { type KnowledgeBaseRow, knowledgeBaseRepo, knowledgeResourceRepo } from "../server/repositories/knowledge-base";
import { createApiKnowledgeBaseRoutes } from "../server/routes/api/knowledge-bases";
import { initializeKnowledgeModuleConfig } from "../server/testing";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

/**
 * 认证上下文由守卫替身写入（真实守卫属宿主，包内不得依赖它构造路由）。
 * 取值与迁移前 `setTestAuth()` / `setTestOrgContext()` 注入的一致：`{ organizationId: "org-1", userId: "user-1" }`。
 */
const AUTH_CONTEXT = { organizationId: "org-1", userId: "user-1" } as const;
const apiKnowledgeBasesRoute = createApiKnowledgeBaseRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(AUTH_CONTEXT),
});
/** 拒绝态守卫（`authContext = null` 返回 401）：用于断言端点确实声明了 `sessionAuth`。 */
const deniedApiKnowledgeBasesRoute = createApiKnowledgeBaseRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(null),
});

function request(path: string, init?: RequestInit) {
  return apiKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

function deniedRequest(path: string, init?: RequestInit) {
  return deniedApiKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

/** 列表行的固定时间戳：`sanitizeKnowledgeBase` 会把 Date 折算成秒级 Unix 时间。 */
const CREATED_AT_SECONDS = 1718000000;
const UPDATED_AT_SECONDS = 1718000100;

function knowledgeBaseRow(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "Product Docs",
    slug: "product-docs",
    description: "knowledge for product docs",
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: "org-1",
    remoteUserId: "user-1",
    // 配置类字段存在 metadata 里（见 `knowledge-metadata`），回显时拉平成 DTO 字段。
    metadata: { parseMethod: "builtin", chunkMethod: "naive" },
    status: "ready",
    lastError: null,
    createdAt: new Date(CREATED_AT_SECONDS * 1000),
    updatedAt: new Date(UPDATED_AT_SECONDS * 1000),
    ...overrides,
  };
}

const originals = {
  listByOrganizationId: knowledgeBaseRepo.listByOrganizationId,
  listGlobal: knowledgeBaseRepo.listGlobal,
  countBindings: knowledgeBaseRepo.countBindings,
  countByKnowledgeBase: knowledgeResourceRepo.countByKnowledgeBase,
};

describe("API Knowledge Base Routes", () => {
  beforeEach(() => {
    // repository 是包内唯一数据访问点，所以这里替身替换 repository 而不是 stub 掉 service：
    // 覆盖范围因此包含 `sanitizeKnowledgeBase` 的真实映射（DTO 字段名、时间戳折算、counts 注入）。
    knowledgeBaseRepo.listByOrganizationId = mock(async () => [knowledgeBaseRow()]);
    knowledgeBaseRepo.listGlobal = mock(async () => []);
    knowledgeBaseRepo.countBindings = mock(async () => 2);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 5);
    initializeKnowledgeModuleConfig();
  });

  afterEach(() => {
    knowledgeBaseRepo.listByOrganizationId = originals.listByOrganizationId;
    knowledgeBaseRepo.listGlobal = originals.listGlobal;
    knowledgeBaseRepo.countBindings = originals.countBindings;
    knowledgeResourceRepo.countByKnowledgeBase = originals.countByKnowledgeBase;
  });

  // 外部知识库列表接口应返回稳定分页结构，而不是直接返回裸数组。
  test("GET /api/knowledge-bases returns paginated knowledge base list", async () => {
    const res = await request("/api/knowledge-bases?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      items: [
        {
          id: "kb-1",
          name: "Product Docs",
          slug: "product-docs",
          description: "knowledge for product docs",
          provider: "ragflow",
          remoteId: "remote-kb-1",
          remoteAccountId: "org-1",
          remoteUserId: "user-1",
          status: "ready",
          lastError: null,
          bindingsCount: 2,
          resourcesCount: 5,
          recentResources: [],
          createdAt: CREATED_AT_SECONDS,
          updatedAt: UPDATED_AT_SECONDS,
          userId: "user-1",
          organizationId: "org-1",
          embeddingModel: null,
          parseMethod: "builtin",
          chunkMethod: "naive",
          remoteExists: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });

  // 对外接口同样必须挂上会话守卫：缺少认证上下文时不得返回成功 DTO。
  test("GET /api/knowledge-bases 缺少认证上下文返回 401", async () => {
    const res = await deniedRequest("/api/knowledge-bases?page=1&pageSize=10");
    expect(res.status).toBe(401);
  });
});
