import { beforeEach, describe, expect, test } from "bun:test";
import {
  type AuthorizedResourceQuery,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceQueryConstraint,
  type ScopedRow,
} from "@fenix/platform-sdk";
import { stubDb } from "@fenix/platform-sdk/testing";
import { PgDialect } from "drizzle-orm/pg-core";
import { AGENT_SITE_APP_RESOURCE_TYPE, agentSiteAppResource } from "../server/access/agent-site-app-resource";
import {
  type AgentSiteAppQueryStorage,
  type AgentSiteAppRow,
  createAgentSiteAppRepository,
  type ScopedAgentSiteAppRow,
} from "../server/repositories/agent-site-app";
import { initializeAgentConfigModuleConfig } from "../server/testing";

/**
 * 站点 App 仓储用例：写路径直连 DB 句柄，受控读取把授权条件与业务条件下推给平台查询端口。
 *
 * 读取的**规则**（谁能读、读什么范围）不在这里验证——那是 `agent-site-app-service.test.ts`（业务条件）
 * 与 `agent-site-app-facade.test.ts`（授权编排）的范围；本文件只证明仓储把端口入参原样传下去、
 * 并回到端口产出的行。
 */

/** 授权条件句柄替身：仓储只原样转发，不解释内容（内部结构对资源包不可见）。 */
function siteConstraint(): ResourceQueryConstraint {
  return {
    resourceType: AGENT_SITE_APP_RESOURCE_TYPE,
    action: "read",
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: {},
  };
}

/** 记录调用入参的授权查询替身；返回固定行，不解释条件（条件的语义由平台实现负责）。 */
function createRecordingQuery(rows: readonly AgentSiteAppRow[] = []) {
  const listCalls: Array<Record<string, unknown>> = [];
  const findCalls: Array<Record<string, unknown>> = [];
  const scoped = rows.map((row) => ({ ...row, scope: { visibility: "private" as const } })) as ScopedAgentSiteAppRow[];
  const query: AuthorizedResourceQuery<AgentSiteAppQueryStorage> = {
    list: async (input) => {
      listCalls.push(input as unknown as Record<string, unknown>);
      return { items: scoped as readonly ScopedRow<AgentSiteAppRow>[] };
    },
    count: async () => scoped.length,
    findById: async (input) => {
      findCalls.push(input as unknown as Record<string, unknown>);
      return scoped.find((row) => row.id === (input as { resourceId: string }).resourceId);
    },
  };
  return { query, listCalls, findCalls };
}

/** 站点行替身；只填断言用得到的列。 */
function siteRow(overrides: Partial<AgentSiteAppRow> = {}): AgentSiteAppRow {
  return {
    id: "app-uuid-1",
    organizationId: "org-1",
    userId: "user-1",
    remoteAppId: "app-abc12345",
    name: "test-app",
    description: null,
    platformToken: "tok-xxx.yyy",
    platformTokenId: "tok-001",
    visibility: "private",
    appType: "pocketbase",
    entryFile: null,
    activeSlot: null,
    deployedAt: null,
    createdByAgentConfigId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    ...overrides,
  };
}

describe("agent-site-app 仓储", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
  });

  // 列表读取必须把授权条件、资源类型、主表归属列与业务条件一起交给平台端口：漏传任何一项都会让授权谓词无处可放。
  test("listReadable 把资源绑定与业务条件下推给平台查询端口", async () => {
    const { query, listCalls } = createRecordingQuery([siteRow()]);
    const repository = createAgentSiteAppRepository(query);
    const constraint = siteConstraint();

    const rows = await repository.listReadable({ access: constraint, businessWhere: [], limit: 1 });

    expect(rows).toHaveLength(1);
    expect(listCalls).toHaveLength(1);
    // 条件必须按同一引用透传：端口把 `undefined` 的 `access` 当作"本次查询没有授权谓词"（`readFacts`
    // 直接返回 `undefined`，WHERE 里只剩业务条件），漏传即静默退化成全量可读，而类型上察觉不到。
    expect(listCalls[0]?.access).toBe(constraint);
    expect(listCalls[0]?.resourceType).toBe(AGENT_SITE_APP_RESOURCE_TYPE);
    expect(listCalls[0]?.columns).toEqual(agentSiteAppResource.storage.columns);
    expect(listCalls[0]?.limit).toBe(1);
  });

  // 详情读取按资源 ID；端口必须收到同一个 ID 与同一条授权条件，仓储不自行拼 ID 条件、也不省略谓词。
  test("findReadableById 按资源 ID 走端口 findById", async () => {
    const { query, findCalls } = createRecordingQuery([siteRow({ id: "target" })]);
    const repository = createAgentSiteAppRepository(query);
    const constraint = siteConstraint();

    const row = await repository.findReadableById({ access: constraint, resourceId: "target" });
    expect(row?.id).toBe("target");
    expect(findCalls[0]?.access).toBe(constraint);
    expect(findCalls[0]?.resourceId).toBe("target");
  });

  // 创建写入口：默认发布范围为 private、默认类型为 pocketbase，归属列随同一次 INSERT 写入。
  test("create 写入归属列并补默认值", async () => {
    const captured: Record<string, unknown> = {};
    stubDb({
      insert: () => ({
        values: (data: Record<string, unknown>) => {
          Object.assign(captured, data);
          return { returning: () => Promise.resolve([siteRow()]) };
        },
      }),
    });

    const repository = createAgentSiteAppRepository(createRecordingQuery().query);
    const row = await repository.create({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-abc12345",
      name: "test-app",
      platformToken: "tok-xxx.yyy",
      platformTokenId: "tok-001",
    });

    expect(row.id).toBe("app-uuid-1");
    expect(captured.organizationId).toBe("org-1");
    expect(captured.userId).toBe("user-1");
    expect(captured.visibility).toBe("private");
    expect(captured.appType).toBe("pocketbase");
  });

  // 创建期发布范围与类型由调用方给出时不得被默认值覆盖（custom app 与公开站点都依赖这一点）。
  test("create 使用调用方给出的发布范围与类型", async () => {
    const captured: Record<string, unknown> = {};
    stubDb({
      insert: () => ({
        values: (data: Record<string, unknown>) => {
          Object.assign(captured, data);
          return { returning: () => Promise.resolve([siteRow({ visibility: "public", appType: "custom" })]) };
        },
      }),
    });

    const repository = createAgentSiteAppRepository(createRecordingQuery().query);
    await repository.create({
      organizationId: "org-1",
      userId: "user-1",
      remoteAppId: "app-public01",
      name: "public-app",
      platformToken: "tok-2",
      platformTokenId: "tok-002",
      visibility: "public",
      appType: "custom",
    });

    expect(captured.visibility).toBe("public");
    expect(captured.appType).toBe("custom");
  });

  // 更新写入口必须透传部署元数据，并统一刷新 updatedAt。
  test("update 透传部署字段并刷新时间戳", async () => {
    const captured: Record<string, unknown> = {};
    stubDb({
      update: () => ({
        set: (data: Record<string, unknown>) => {
          Object.assign(captured, data);
          return { where: () => ({ returning: () => Promise.resolve([siteRow()]) }) };
        },
      }),
    });

    const repository = createAgentSiteAppRepository(createRecordingQuery().query);
    const deployedAt = new Date("2026-07-01T00:00:00.000Z");
    await repository.update("app-uuid-1", { entryFile: "main.ts", activeSlot: "a", deployedAt });

    expect(captured.entryFile).toBe("main.ts");
    expect(captured.activeSlot).toBe("a");
    expect(captured.deployedAt).toEqual(deployedAt);
    expect(captured.updatedAt).toBeInstanceOf(Date);
  });

  // 删除入口按行数判定结果：0 行表示目标已不存在，调用方据此区分"已删除"与"未命中"。
  test("remove 按影响行数返回布尔值", async () => {
    stubDb({ delete: () => ({ where: () => Promise.resolve({ count: 0 }) }) });

    const repository = createAgentSiteAppRepository(createRecordingQuery().query);
    expect(await repository.remove("missing")).toBe(false);
  });

  // 发布面（无 actor 的站点代理）按远端 app id 定位，绝不按资源 ID 混用。
  test("findByRemoteAppIdUnscoped 按远端 app id 查询", async () => {
    const conditions: unknown[] = [];
    stubDb({
      select: () => ({
        from: () => ({
          where: (condition: unknown) => {
            conditions.push(condition);
            return { limit: () => Promise.resolve([siteRow({ remoteAppId: "app-remote" })]) };
          },
        }),
      }),
    });

    const repository = createAgentSiteAppRepository(createRecordingQuery().query);
    const row = await repository.findByRemoteAppIdUnscoped("app-remote");

    expect(row?.remoteAppId).toBe("app-remote");
    expect(conditions).toHaveLength(1);
    // 条件落在 remote_app_id 列上，而不是 id 列（两种定位方式不能混用）。
    expect(new PgDialect().sqlToQuery(conditions[0] as never).sql).toContain("remote_app_id");
  });
});
