import { beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createKnowledgeBaseRecord,
  resolveKnowledgeTenantIdentity,
  sanitizeKnowledgeBase,
} from "../services/knowledge-base";
import { listKnowledgeResources } from "../services/knowledge-upload";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("知识库服务边界", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 创建请求缺少有效名称时必须在访问数据库和 provider 前返回输入校验错误。
  test("空白知识库名称被本地校验拒绝", async () => {
    const result = await createKnowledgeBaseRecord("org-1", { name: "   " }, "user-1");

    expect(result).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "知识库名称不能为空" },
    });
  });

  // slug 含有非法字符时必须在创建远端数据集前被拒绝，避免产生孤儿资源。
  test("非法 slug 被本地校验拒绝", async () => {
    const result = await createKnowledgeBaseRecord("org-1", { name: "文档", slug: "invalid slug!" }, "user-1");

    expect(result).toEqual({
      success: false,
      error: { code: "VALIDATION_ERROR", message: "slug 只能包含字母、数字和连字符" },
    });
  });

  // 组织不匹配的知识库不得暴露其资源列表，也不得继续解析 provider 凭据。
  test("跨组织读取资源列表返回空结果", async () => {
    const select = mock(() => ({
      from: () => ({
        where: () => ({
          limit: () =>
            Promise.resolve([
              {
                id: "kb-foreign",
                organizationId: "org-foreign",
                userId: "user-foreign",
                remoteId: "remote-foreign",
              },
            ]),
        }),
      }),
    }));
    stubDb({ select });

    await expect(listKnowledgeResources("org-1", "kb-foreign", "user-1")).resolves.toBeNull();
    expect(select).toHaveBeenCalledTimes(1);
  });

  // 远端租户标识为空白时必须回退到知识库所有者，避免向上游传递无效身份。
  test("远端租户标识空白时回退到知识库所有者", () => {
    expect(
      resolveKnowledgeTenantIdentity({
        userId: " owner-1 ",
        remoteAccountId: "   ",
        remoteUserId: null,
      }),
    ).toEqual({ remoteAccountId: "owner-1", remoteUserId: "owner-1" });
  });

  // 知识库响应必须将可选持久化字段标准化为 null 和秒级时间戳，保持 API DTO 稳定。
  test("知识库响应映射标准化可选字段与时间", () => {
    const result = sanitizeKnowledgeBase({
      id: "kb-1",
      userId: "user-1",
      organizationId: "org-1",
      name: "产品文档",
      slug: "product-docs",
      description: null,
      provider: null,
      remoteId: null,
      remoteAccountId: null,
      remoteUserId: null,
      metadata: null,
      status: "empty",
      lastError: null,
      createdAt: new Date("2026-01-01T00:00:00.999Z"),
      updatedAt: new Date("2026-01-01T00:00:01.001Z"),
    });

    expect(result).toMatchObject({
      description: null,
      provider: null,
      remoteId: null,
      embeddingModel: null,
      parseMethod: null,
      chunkMethod: null,
      createdAt: 1767225600,
      updatedAt: 1767225601,
      bindingsCount: 0,
      resourcesCount: 0,
      remoteExists: true,
      recentResources: [],
    });
  });
});
