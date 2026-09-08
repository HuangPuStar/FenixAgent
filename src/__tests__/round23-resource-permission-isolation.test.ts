import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import type { IOrganizationRepo } from "../repositories/organization";
import type {
  CreateResourcePermissionGrantInput,
  DeleteResourcePermissionGrantInput,
  IResourcePermissionRepo,
  ResourcePermissionAccessibleRow,
  ResourcePermissionOwnedRow,
} from "../repositories/resource-permission";
import {
  _resetDeps,
  assertInternalWritable,
  buildResourceAccess,
  canReadResource,
  decorateResourceAccess,
  getPublicReadMap,
  listReadableResourceRefs,
  setOrganizationRepoForTesting,
  setPublicRead,
  setResourcePermissionRepoForTesting,
} from "../services/resource-permission";

const ctx: AuthContext = { organizationId: "org-a", userId: "user-a", role: "owner" };
const otherCtx: AuthContext = { organizationId: "org-b", userId: "user-b", role: "member" };

type ResourcePermissionGrant = Awaited<ReturnType<IResourcePermissionRepo["createGrant"]>>;

function grant(input: CreateResourcePermissionGrantInput): ResourcePermissionGrant {
  return {
    ...input,
    id: "grant-1",
    createdAt: new Date("2026-08-19T00:00:00.000Z"),
    updatedAt: new Date("2026-08-19T00:00:00.000Z"),
  };
}

function createRepo(overrides: Partial<IResourcePermissionRepo> = {}): IResourcePermissionRepo {
  return {
    listByResource: async () => [],
    createGrant: async (input) => grant(input),
    deleteGrant: async () => true,
    listOwnedByOrganization: async () => [],
    listAccessibleForPrincipal: async () => [],
    canReadExternalResource: async () => false,
    ...overrides,
  };
}

function createOrganizationRepo(names: Record<string, string> = {}): IOrganizationRepo {
  return {
    listNamesByIds: async (ids) => new Map(ids.flatMap((id) => (names[id] ? [[id, names[id]]] : []))),
  };
}

beforeEach(() => {
  _resetDeps();
});

afterEach(() => {
  _resetDeps();
});

describe("resource-permission 组织隔离与授权边界", () => {
  // 同组织资源必须标记为内部资源。
  test("内部资源标记为 internal", () => {
    expect(buildResourceAccess(ctx, "skill", { id: "skill-1", organizationId: "org-a" }).ownership).toBe("internal");
  });

  // 外部组织资源必须标记为 external，避免误授予写权限。
  test("外部资源标记为 external", () => {
    expect(buildResourceAccess(ctx, "skill", { id: "skill-1", organizationId: "org-b" }).ownership).toBe("external");
  });

  // 内部资源允许管理。
  test("内部资源允许管理", () => {
    expect(buildResourceAccess(ctx, "provider", { id: "provider-1", organizationId: "org-a" }).manageable).toBeTrue();
  });

  // 外部资源禁止管理。
  test("外部资源禁止管理", () => {
    expect(buildResourceAccess(ctx, "provider", { id: "provider-1", organizationId: "org-b" }).manageable).toBeFalse();
  });

  // 内部资源允许写入。
  test("内部资源允许写入", () => {
    expect(buildResourceAccess(ctx, "mcp_server", { id: "mcp-1", organizationId: "org-a" }).writable).toBeTrue();
  });

  // 外部资源禁止写入。
  test("外部资源禁止写入", () => {
    expect(buildResourceAccess(ctx, "mcp_server", { id: "mcp-1", organizationId: "org-b" }).writable).toBeFalse();
  });

  // 内部资源携带公开读取状态。
  test("内部资源保留公开读取状态", () => {
    expect(
      buildResourceAccess(ctx, "skill", { id: "skill-1", organizationId: "org-a" }, true).publicReadable,
    ).toBeTrue();
  });

  // 未提供公开读取状态时保持未设置，避免伪造授权信息。
  test("内部资源未设置公开读取状态", () => {
    expect(
      buildResourceAccess(ctx, "skill", { id: "skill-1", organizationId: "org-a" }).publicReadable,
    ).toBeUndefined();
  });

  // 已确认的外部公开授权状态可安全暴露，用于区分公开资源与组织定向共享资源。
  test("外部资源保留已确认的公开读取状态", () => {
    expect(
      buildResourceAccess(ctx, "skill", { id: "skill-1", organizationId: "org-b" }, true).publicReadable,
    ).toBeTrue();
  });

  // 资源键必须保留源组织和资源标识。
  test("资源键包含组织与资源标识", () => {
    expect(buildResourceAccess(ctx, "skill", { id: "skill-1", organizationId: "org-b" }).resourceKey).toBe(
      "org-b/skill-1",
    );
  });

  // 来源组织名称用于外部资源展示。
  test("资源访问映射保留来源组织名称", () => {
    expect(
      buildResourceAccess(ctx, "skill", { id: "skill-1", organizationId: "org-b" }, false, "组织 B")
        .sourceOrganizationName,
    ).toBe("组织 B");
  });

  // 可读资源列表必须滤掉当前组织自身的记录。
  test("可读资源列表排除本组织记录", async () => {
    setResourcePermissionRepoForTesting(
      createRepo({
        listAccessibleForPrincipal: async (): Promise<ResourcePermissionAccessibleRow[]> => [
          { organizationId: "org-a", resourceType: "skill", resourceId: "internal", hasPublicRead: true },
          { organizationId: "org-b", resourceType: "skill", resourceId: "external", hasPublicRead: true },
        ],
      }),
    );
    expect(await listReadableResourceRefs(ctx, "skill")).toEqual([
      { organizationId: "org-b", resourceType: "skill", resourceId: "external", hasPublicRead: true },
    ]);
  });

  // 空可读列表应稳定返回空数组。
  test("空可读资源列表返回空数组", async () => {
    setResourcePermissionRepoForTesting(createRepo());
    expect(await listReadableResourceRefs(ctx, "skill")).toEqual([]);
  });

  // 公开读映射仅包含请求的资源标识。
  test("公开读映射过滤未请求资源", async () => {
    setResourcePermissionRepoForTesting(
      createRepo({
        listOwnedByOrganization: async (): Promise<ResourcePermissionOwnedRow[]> => [
          { organizationId: "org-a", resourceType: "skill", resourceId: "wanted", grantCount: 1, hasPublicRead: true },
          { organizationId: "org-a", resourceType: "skill", resourceId: "other", grantCount: 1, hasPublicRead: true },
        ],
      }),
    );
    expect(await getPublicReadMap(ctx, "skill", ["wanted"])).toEqual(new Map([["wanted", true]]));
  });

  // 没有请求资源时仍查询所属权限但产生空映射。
  test("空资源标识返回空公开读映射", async () => {
    setResourcePermissionRepoForTesting(createRepo());
    expect(await getPublicReadMap(ctx, "skill", [])).toEqual(new Map());
  });

  // 空资源数组仍会安全完成公开读映射查询。
  test("装饰空资源数组不查询仓储", async () => {
    let ownedQueries = 0;
    setResourcePermissionRepoForTesting(
      createRepo({
        listOwnedByOrganization: async (): Promise<ResourcePermissionOwnedRow[]> => {
          ownedQueries += 1;
          return [];
        },
      }),
    );
    setOrganizationRepoForTesting(createOrganizationRepo());
    expect(await decorateResourceAccess(ctx, "skill", [])).toEqual([]);
    expect(ownedQueries).toBe(1);
  });

  // 装饰器为内部资源附加公开读与组织名。
  test("装饰内部资源访问元数据", async () => {
    setResourcePermissionRepoForTesting(
      createRepo({
        listOwnedByOrganization: async (): Promise<ResourcePermissionOwnedRow[]> => [
          { organizationId: "org-a", resourceType: "skill", resourceId: "skill-1", grantCount: 1, hasPublicRead: true },
        ],
      }),
    );
    setOrganizationRepoForTesting(createOrganizationRepo({ "org-a": "组织 A" }));
    const [result] = await decorateResourceAccess(ctx, "skill", [
      { id: "skill-1", organizationId: "org-a", name: "内部技能" },
    ]);
    expect(result).toMatchObject({
      name: "内部技能",
      resourceAccess: { ownership: "internal", publicReadable: true, sourceOrganizationName: "组织 A" },
    });
  });

  // 装饰器为外部资源保留只读边界。
  test("装饰外部资源为只读", async () => {
    setResourcePermissionRepoForTesting(createRepo());
    setOrganizationRepoForTesting(createOrganizationRepo({ "org-b": "组织 B" }));
    const [result] = await decorateResourceAccess(ctx, "skill", [{ id: "skill-2", organizationId: "org-b" }]);
    expect(result.resourceAccess).toMatchObject({
      ownership: "external",
      writable: false,
      manageable: false,
      sourceOrganizationName: "组织 B",
    });
  });

  // 装饰器需要去重组织名称查询输入。
  test("装饰器去重组织名称查询", async () => {
    let receivedIds: string[] = [];
    setResourcePermissionRepoForTesting(createRepo());
    setOrganizationRepoForTesting({
      listNamesByIds: async (ids) => {
        receivedIds = ids;
        return new Map<string, string>();
      },
    });
    await decorateResourceAccess(ctx, "skill", [
      { id: "one", organizationId: "org-b" },
      { id: "two", organizationId: "org-b" },
    ]);
    expect(receivedIds).toEqual(["org-b"]);
  });

  // 装饰器支持并发处理不同资源类型。
  test("装饰器在并发调用中保持组织隔离", async () => {
    setResourcePermissionRepoForTesting(createRepo());
    setOrganizationRepoForTesting(createOrganizationRepo({ "org-a": "组织 A", "org-b": "组织 B" }));
    const [internal, external] = await Promise.all([
      decorateResourceAccess(ctx, "skill", [{ id: "one", organizationId: "org-a" }]),
      decorateResourceAccess(ctx, "provider", [{ id: "two", organizationId: "org-b" }]),
    ]);
    expect([internal[0]?.resourceAccess.ownership, external[0]?.resourceAccess.ownership]).toEqual([
      "internal",
      "external",
    ]);
  });

  // 同组织读取无需查询外部授权仓储。
  test("同组织读取直接允许", async () => {
    let queried = false;
    setResourcePermissionRepoForTesting(
      createRepo({
        canReadExternalResource: async () => {
          queried = true;
          return false;
        },
      }),
    );
    expect(await canReadResource(ctx, "skill", "skill-1", "org-a")).toBeTrue();
    expect(queried).toBeFalse();
  });

  // 外部读取必须委托授权仓储决定。
  test("外部读取委托授权仓储", async () => {
    let args: string[] = [];
    setResourcePermissionRepoForTesting(
      createRepo({
        canReadExternalResource: async (...input) => {
          args = input;
          return true;
        },
      }),
    );
    expect(await canReadResource(ctx, "skill", "skill-1", "org-b")).toBeTrue();
    expect(args).toEqual(["org-b", "skill", "skill-1", "org-a"]);
  });

  // 外部读取在授权仓储拒绝时必须拒绝。
  test("外部读取遵从拒绝结果", async () => {
    setResourcePermissionRepoForTesting(createRepo({ canReadExternalResource: async () => false }));
    expect(await canReadResource(ctx, "skill", "skill-1", "org-b")).toBeFalse();
  });

  // 内部公开读写入应创建 all/read 授权。
  test("开启公开读创建全体读取授权", async () => {
    let created: CreateResourcePermissionGrantInput | undefined;
    setResourcePermissionRepoForTesting(
      createRepo({
        createGrant: async (input) => {
          created = input;
          return grant(input);
        },
      }),
    );
    await setPublicRead(ctx, "skill", "org-a", "skill-1", true);
    expect(created).toEqual({
      organizationId: "org-a",
      resourceType: "skill",
      resourceId: "skill-1",
      principalType: "all",
      principalId: null,
      action: "read",
      createdBy: "user-a",
    });
  });

  // 关闭公开读应删除同一授权身份。
  test("关闭公开读删除全体读取授权", async () => {
    let deleted: DeleteResourcePermissionGrantInput | undefined;
    setResourcePermissionRepoForTesting(
      createRepo({
        deleteGrant: async (input) => {
          deleted = input;
          return true;
        },
      }),
    );
    await setPublicRead(ctx, "agent_config", "org-a", "agent-1", false);
    expect(deleted).toEqual({
      organizationId: "org-a",
      resourceType: "agent_config",
      resourceId: "agent-1",
      principalType: "all",
      principalId: null,
      action: "read",
    });
  });

  // 外部资源不得开启公开读。
  test("外部资源开启公开读返回 FORBIDDEN", async () => {
    expect(() => assertInternalWritable(ctx, "skill", "skill-1", "org-b")).toThrow(AppError);
    expect(() => assertInternalWritable(ctx, "skill", "skill-1", "org-b")).toThrow("External resource is read-only");
  });

  // 外部资源不得关闭公开读。
  test("外部资源关闭公开读返回 FORBIDDEN", async () => {
    await expect(setPublicRead(ctx, "skill", "org-b", "skill-1", false)).rejects.toMatchObject({
      code: "FORBIDDEN",
      statusCode: 403,
    });
  });

  // 内部可写断言不应抛出错误。
  test("内部资源通过可写断言", () => {
    expect(() => assertInternalWritable(ctx, "skill", "skill-1", "org-a")).not.toThrow();
  });

  // 不同认证上下文只能管理自身组织资源。
  test("不同组织上下文不能管理对方资源", () => {
    expect(() => assertInternalWritable(otherCtx, "provider", "provider-1", "org-a")).toThrow(AppError);
  });

  // 依赖复位后不应沿用先前的注入实现。
  test("依赖复位释放测试注入", async () => {
    setResourcePermissionRepoForTesting(createRepo({ canReadExternalResource: async () => true }));
    expect(await canReadResource(ctx, "skill", "skill-1", "org-b")).toBeTrue();
    _resetDeps();
    setResourcePermissionRepoForTesting(createRepo({ canReadExternalResource: async () => false }));
    expect(await canReadResource(ctx, "skill", "skill-1", "org-b")).toBeFalse();
  });

  // 连续公开读操作必须保留各自资源标识。
  test("并发公开读操作不会串扰资源标识", async () => {
    const created: string[] = [];
    setResourcePermissionRepoForTesting(
      createRepo({
        createGrant: async (input) => {
          created.push(input.resourceId);
          return grant(input);
        },
      }),
    );
    await Promise.all([
      setPublicRead(ctx, "skill", "org-a", "skill-1", true),
      setPublicRead(ctx, "skill", "org-a", "skill-2", true),
    ]);
    expect(created.sort()).toEqual(["skill-1", "skill-2"]);
  });
});
