import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubKnowledgeBaseService } from "../test-utils/helpers";

const apiKnowledgeBasesRoute = (await import("../routes/api/knowledge-bases")).default;

function request(path: string, init?: RequestInit) {
  return apiKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Knowledge Base Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    stubKnowledgeBaseService({
      listKnowledgeBasesByTeamId: async () => [
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
          embeddingModel: null,
          parseMethod: null,
          chunkMethod: null,
          createdAt: 1718000000,
          updatedAt: 1718000100,
        },
      ],
    });
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
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
          embeddingModel: null,
          parseMethod: null,
          chunkMethod: null,
          createdAt: 1718000000,
          updatedAt: 1718000100,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });
});
