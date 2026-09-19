import { beforeEach, describe, expect, test } from "bun:test";
import { type ResourceAccess, ResourceAccessDeniedError, type ResourceQueryConstraint } from "@fenix/platform-sdk";
import { ConflictError, ForbiddenError, NotFoundError } from "@server/errors";
import { mcpServerResource } from "../server/access/mcp-server-resource";
import { McpServerFacade } from "../server/facades/mcp-server-facade";
import { createStubMcpServerService } from "../server/testing";
import {
  createFakeAccessControl,
  createRecordingScopeStore,
  denied,
  scopedServer,
  testActor,
  testListConstraint,
} from "./fixtures";

/**
 * MCP 资源应用 Facade 用例。
 *
 * 覆盖"授权编排 + 状态校验 + 跨资源编排"三类行为：授权判断本身由 `access-control` 用例负责，这里
 * 只验证 Facade 是否在正确的时机用正确的输入调用了平台能力，以及平台拒绝如何映射为宿主错误类。
 */

const actor = testActor();

function buildFacade(
  overrides: {
    service?: Parameters<typeof createStubMcpServerService>[0];
    accessControl?: Parameters<typeof createFakeAccessControl>[0];
    scope?: { organizationId?: string; ownerUserId?: string; visibility: "private" | "public" };
  } = {},
) {
  const { store, updates } = createRecordingScopeStore(
    overrides.scope ?? { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
  );
  const facade = new McpServerFacade(createStubMcpServerService(overrides.service), {
    accessControl: createFakeAccessControl(overrides.accessControl),
    resource: mcpServerResource.definition,
    scopeStore: store,
  });
  return { facade, updates };
}

describe("McpServerFacade", () => {
  let constraints: ResourceQueryConstraint[];
  let projectCalls: string[][];

  beforeEach(() => {
    constraints = [];
    projectCalls = [];
  });

  // 列表把授权条件与分页下推给领域服务，并只用一次批量查询补齐权限，避免逐行 N+1。
  test("list 下推条件与分页并批量补齐权限", async () => {
    const listInputs: { access: ResourceQueryConstraint; limit?: number; offset?: number }[] = [];
    const rows = [scopedServer({ id: "mcp-1" }), scopedServer({ id: "mcp-2", name: "other" })];
    const { facade } = buildFacade({
      service: {
        list: async (input) => {
          listInputs.push(input);
          return { items: rows, total: 5 };
        },
        countTools: async ({ serverName }) => serverName.length,
      },
      accessControl: {
        resolveAccessMany: async ({ resourceIds }) => {
          projectCalls.push([...resourceIds]);
          const access: ResourceAccess = { actions: ["read"] };
          return new Map(resourceIds.map((id) => [id, access]));
        },
        createListConstraint: async () => {
          const constraint = testListConstraint();
          constraints.push(constraint);
          return constraint;
        },
      },
    });

    const result = await facade.list(actor, { limit: 2, offset: 4 });

    expect(result.total).toBe(5);
    expect(projectCalls).toEqual([["mcp-1", "mcp-2"]]);
    expect(listInputs[0]?.limit).toBe(2);
    expect(listInputs[0]?.offset).toBe(4);
    expect(listInputs[0]?.access).toBe(constraints[0]);
    expect(result.items.map((item) => item.toolsCount)).toEqual([4, 5]);
    expect(result.items[0]?.access).toEqual({ actions: ["read"] });
  });

  // 空列表不发起批量权限查询：没有资源就没有需要补齐的 access。
  test("list 空结果不查询权限", async () => {
    let projected = false;
    const { facade } = buildFacade({
      service: { list: async () => ({ items: [], total: 0 }) },
      accessControl: {
        resolveAccessMany: async () => {
          projected = true;
          return new Map();
        },
      },
    });

    expect(await facade.list(actor)).toEqual({ items: [], total: 0 });
    expect(projected).toBeFalse();
  });

  // 工具计数是展示信息：查询失败降级为 0，不能让整个列表因缓存表故障而失败。
  test("list 工具计数失败时降级为 0", async () => {
    const { facade } = buildFacade({
      service: {
        list: async () => ({ items: [scopedServer()], total: 1 }),
        countTools: async () => {
          throw new Error("tool table unavailable");
        },
      },
    });

    const result = await facade.list(actor);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.toolsCount).toBe(0);
  });

  // 授权结果缺项说明查询与范围读取不一致，必须报错而不是产出无权限信息的资源。
  test("list 权限结果缺项时报错", async () => {
    const { facade } = buildFacade({
      service: { list: async () => ({ items: [scopedServer()], total: 1 }) },
      accessControl: { resolveAccessMany: async () => new Map() },
    });

    await expect(facade.list(actor)).rejects.toThrow("资源 mcp-1 缺少授权结果");
  });

  // 同名资源可能存在于多个组织：优先当前 active organization，避免外部同名资源遮蔽本组织资源。
  test("get 优先返回当前组织的同名资源", async () => {
    const lookups: (string | undefined)[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async ({ organizationId }) => {
          lookups.push(organizationId);
          return organizationId === "org-1" ? scopedServer() : undefined;
        },
      },
    });

    const found = await facade.get(actor, "demo");

    expect(found?.id).toBe("mcp-1");
    expect(lookups).toEqual(["org-1"]);
  });

  // 当前组织没有同名资源时回退到全局按名查询：跨组织公开资源仍然读得到。
  test("get 在本组织未命中时回退全局查询", async () => {
    const lookups: (string | undefined)[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async ({ organizationId }) => {
          lookups.push(organizationId);
          return organizationId === undefined
            ? scopedServer({ id: "mcp-external", organizationId: "org-source", visibility: "public" })
            : undefined;
        },
      },
    });

    const found = await facade.get(actor, "shared");

    expect(found?.id).toBe("mcp-external");
    expect(lookups).toEqual(["org-1", undefined]);
  });

  // 含 `/` 的名称按跨组织资源键解析，不再按组织内名称查询。
  test("get 用资源键解析跨组织资源", async () => {
    const keys: string[] = [];
    const { facade } = buildFacade({
      service: {
        findByResourceKey: async ({ resourceKey }) => {
          keys.push(resourceKey);
          return scopedServer({ id: "mcp-external", organizationId: "org-source", visibility: "public" });
        },
      },
    });

    expect((await facade.get(actor, "org-source/mcp-external"))?.id).toBe("mcp-external");
    expect(keys).toEqual(["org-source/mcp-external"]);
  });

  // 不可见资源在详情路径上表现为 undefined，由协议层统一映射为 404。
  test("get 不可见时返回 undefined", async () => {
    const { facade } = buildFacade({ service: { findByName: async () => undefined } });

    expect(await facade.get(actor, "missing")).toBeUndefined();
  });

  // 可写读取：不可见返回 404，可见但无 update 动作返回 403，不能混为一种结果。
  test("getWritable 区分不可见与无权限", async () => {
    const invisible = buildFacade({ service: { findByName: async () => undefined } }).facade;
    await expect(invisible.getWritable(actor, "missing")).rejects.toThrow(NotFoundError);

    const deniedAction = buildFacade({
      service: { findByName: async () => scopedServer() },
      accessControl: { authorize: async () => denied() },
    }).facade;
    await expect(deniedAction.getWritable(actor, "demo")).rejects.toThrow(ForbiddenError);
  });

  // 创建把归属与资源行写进同一条 INSERT：组织、owner、展示类型与公开受众都由创建期决定。
  test("create 写入归属与公开受众", async () => {
    const creates: Record<string, unknown>[] = [];
    const { facade } = buildFacade({
      service: {
        create: async (input) => {
          creates.push(input);
          return "mcp-new";
        },
      },
    });

    const id = await facade.create(actor, {
      name: "demo",
      type: "remote",
      config: { type: "remote", url: "https://mcp.example.test" },
      publicReadable: true,
    });

    expect(id).toBe("mcp-new");
    expect(creates[0]).toEqual({
      name: "demo",
      type: "remote",
      config: { type: "remote", url: "https://mcp.example.test" },
      organizationId: "org-1",
      ownerUserId: "user-1",
      visibility: "public",
    });
  });

  // 未显式声明公开时沿用初始归属解析出的可见性，Facade 不额外改写公开受众。
  test("create 默认沿用初始归属的可见性", async () => {
    const creates: Record<string, unknown>[] = [];
    const { facade } = buildFacade({
      accessControl: {
        resolveInitialScope: async () => ({
          organizationId: "org-1",
          ownerUserId: "user-1",
          visibility: "public",
        }),
      },
      service: {
        create: async (input) => {
          creates.push(input);
          return "mcp-new";
        },
      },
    });

    await facade.create(actor, {
      name: "demo",
      type: "local",
      config: { type: "local", command: ["npx", "server"] },
    });

    expect(creates[0]?.visibility).toBe("public");
  });

  // 初始归属解析的权限拒绝映射为 403：member 没有 create 动作时必须在写入前终止。
  test("create 被拒绝时映射为 403", async () => {
    let inserted = false;
    const { facade } = buildFacade({
      service: {
        create: async () => {
          inserted = true;
          return "mcp-new";
        },
      },
      accessControl: {
        resolveInitialScope: async () => {
          throw new ResourceAccessDeniedError("当前主体无权创建该资源");
        },
      },
    });

    await expect(
      facade.create(actor, { name: "demo", type: "remote", config: { type: "remote", url: "https://x.test" } }),
    ).rejects.toThrow(ForbiddenError);
    expect(inserted).toBeFalse();
  });

  // 同组织同名由唯一索引拦下（INSERT 返回空集），并发创建不得静默改写既有配置。
  test("create 名称冲突时返回 409", async () => {
    const { facade } = buildFacade({ service: { create: async () => undefined } });

    await expect(
      facade.create(actor, { name: "demo", type: "remote", config: { type: "remote", url: "https://x.test" } }),
    ).rejects.toThrow(ConflictError);
  });

  // 组织资源缺少归属组织说明装配或身份上下文有误，必须显式失败而不是写入孤儿行。
  test("create 缺少归属组织时报错", async () => {
    let inserted = false;
    const { facade } = buildFacade({
      service: {
        create: async () => {
          inserted = true;
          return "mcp-new";
        },
      },
      accessControl: { resolveInitialScope: async () => ({ ownerUserId: "user-1", visibility: "private" }) },
    });

    await expect(
      facade.create(actor, { name: "demo", type: "remote", config: { type: "remote", url: "https://x.test" } }),
    ).rejects.toThrow("MCP server 归属组织缺失");
    expect(inserted).toBeFalse();
  });

  // 不传公开开关时只改连接配置，不触碰 visibility 列。
  test("update 未显式传入公开开关时不改可见性", async () => {
    const patches: Record<string, unknown>[] = [];
    const { facade, updates } = buildFacade({
      service: {
        findByName: async () => scopedServer(),
        update: async (input) => {
          patches.push(input);
          return true;
        },
      },
    });

    await facade.update(actor, "demo", { type: "remote", url: "https://new.example.test" });

    expect(patches).toEqual([{ resourceId: "mcp-1", config: { type: "remote", url: "https://new.example.test" } }]);
    expect(updates).toEqual([]);
  });

  // 显式传入公开开关时在配置更新之后单独更新可见性，且必须重新校验 update 动作。
  test("update 显式传入公开开关时更新可见性", async () => {
    const { facade, updates } = buildFacade({
      service: { findByName: async () => scopedServer(), update: async () => true },
    });

    await facade.update(actor, "demo", { type: "remote", url: "https://new.example.test" }, { publicReadable: false });

    expect(updates).toEqual([{ organizationId: "org-1", ownerUserId: "user-1", visibility: "private" }]);
  });

  // 配置更新影响 0 行说明资源在读取后被删除，必须报 404 而不是返回成功。
  test("update 影响零行时返回 404", async () => {
    const { facade } = buildFacade({
      service: { findByName: async () => scopedServer(), update: async () => false },
    });

    await expect(facade.update(actor, "demo", { type: "remote", url: "https://x.test" })).rejects.toThrow(
      NotFoundError,
    );
  });

  // 删除把归属组织与资源名一并交给领域服务：tools 缓存清理与主表删除在同一事务内完成。
  test("remove 传递归属信息以清理工具缓存", async () => {
    const removals: Record<string, unknown>[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedServer(),
        remove: async (input) => {
          removals.push(input);
          return true;
        },
      },
    });

    await facade.remove(actor, "demo");

    expect(removals).toEqual([{ resourceId: "mcp-1", organizationId: "org-1", serverName: "demo" }]);
  });

  // 无 delete 动作时必须在删除前终止：其他组织的公开资源可读但不可删。
  test("remove 无 delete 动作时不删除", async () => {
    let removed = false;
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedServer({ organizationId: "org-source", visibility: "public" }),
        remove: async () => {
          removed = true;
          return true;
        },
      },
      accessControl: { authorize: async () => denied() },
    });

    await expect(facade.remove(actor, "shared")).rejects.toThrow(ForbiddenError);
    expect(removed).toBeFalse();
  });

  // 启停以资源自身名称为返回标识，影响 0 行时报 404。
  test("setEnabled 返回资源名称并在缺失时报 404", async () => {
    const states: boolean[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedServer(),
        setEnabled: async ({ enabled }) => {
          states.push(enabled);
          return true;
        },
      },
    });

    expect(await facade.setEnabled(actor, "demo", false)).toBe("demo");
    expect(states).toEqual([false]);

    const missing = buildFacade({
      service: { findByName: async () => scopedServer(), setEnabled: async () => false },
    }).facade;
    await expect(missing.setEnabled(actor, "demo", true)).rejects.toThrow(NotFoundError);
  });

  // 工具清单按资源自身的归属组织与名称查询缓存，与查询用的资源键无关。
  test("listTools 以资源自身归属查询缓存", async () => {
    const queries: Record<string, unknown>[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedServer({ name: "shared", organizationId: "org-1" }),
        listTools: async (input) => {
          queries.push(input);
          return [];
        },
      },
    });

    const result = await facade.listTools(actor, "demo");

    expect(result).toEqual({ name: "shared", tools: [] });
    expect(queries).toEqual([{ organizationId: "org-1", serverName: "shared" }]);
  });

  // 保存检测结果要求可写资源，且以替换语义写入：同一服务器的旧工具不会残留。
  test("saveInspectedTools 要求可写并整体替换", async () => {
    const replaced: Record<string, unknown>[] = [];
    const { facade } = buildFacade({
      service: {
        findByName: async () => scopedServer(),
        replaceTools: async (input) => {
          replaced.push(input);
        },
      },
    });

    const name = await facade.saveInspectedTools(actor, "demo", [{ name: "审计" }]);

    expect(name).toBe("demo");
    expect(replaced).toEqual([{ organizationId: "org-1", serverName: "demo", tools: [{ name: "审计" }] }]);
  });
});
