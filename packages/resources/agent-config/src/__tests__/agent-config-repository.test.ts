import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AuthorizedResourceQuery,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceQueryConstraint,
} from "@fenix/platform-sdk";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { AGENT_CONFIG_RESOURCE_TYPE, agentConfigResource } from "../server/access/agent-config-resource";
import {
  AGENT_CONFIG_LIST_ORDER,
  type AgentConfigQueryStorage,
  createAgentConfigRepository,
  type ScopedAgentConfigRow,
} from "../server/repositories/agent-config-resource";
import { initializeAgentConfigModuleConfig } from "../server/testing";

/**
 * AgentConfig 仓储的下推向导（对应计划 S4 的「逐包路由测试 + 下推断言」验收）。
 *
 * 本文件断言「授权条件如何到达 SQL」：仓储把 Facade 产出的**不透明条件**原样交给授权查询端口，
 * 自己不读取、不解释、也不在内存里过滤结果。谓词编译与动作推导的等价性由 `@fenix/access-control`
 * 的 `authorization-consistency.test.ts` 覆盖，这里补的是资源包这一侧的三件事：条件必须下推、
 * 列表与计数必须共用同一条件、组织限定必须进 WHERE 而不是查询后再比对。
 *
 * 写路径不属于授权范围，因此单独断言「归属列不出现在任何写入负载里」——这是资源不漂移的前提。
 */

/** 构造平台上授权条件句柄；形状与 `DefaultAccessControl` 产出的条件一致（含私有载荷键）。 */
function testListConstraint(action: "read" | "use" = "read"): ResourceQueryConstraint {
  return {
    resourceType: agentConfigResource.definition.type,
    action,
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action },
  };
}

/** AgentConfig 主表行的最小完整夹具；未列出的列按建表默认值补齐。 */
function agentConfigRow(overrides: Partial<ScopedAgentConfigRow> = {}): ScopedAgentConfigRow {
  const organizationId = overrides.organizationId ?? "org-1";
  return {
    id: "agent-1",
    userId: "user-1",
    organizationId,
    name: "demo",
    model: null,
    modelId: null,
    prompt: null,
    description: null,
    machineId: null,
    agentNode: null,
    extra: null,
    engineType: "opencode",
    visibility: "private",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: { organizationId, ownerUserId: "user-1", visibility: "private" },
    ...overrides,
  };
}

/** 记录端口入参的授权查询替身；返回行由用例给定。 */
function createRecordingQuery(rows: readonly ScopedAgentConfigRow[] = []) {
  const listInputs: unknown[] = [];
  const countInputs: unknown[] = [];
  const findInputs: unknown[] = [];
  const query: AuthorizedResourceQuery<AgentConfigQueryStorage> = {
    list: async (input) => {
      listInputs.push(input);
      return { items: [...rows], total: rows.length };
    },
    count: async (input) => {
      countInputs.push(input);
      return rows.length;
    },
    findById: async (input) => {
      findInputs.push(input);
      return rows[0];
    },
  };
  return { query, listInputs, countInputs, findInputs };
}

/** 从端口入参取出授权条件，断言「传的是同一个句柄」而非被复制或重写过的形状。 */
function accessOf(input: unknown): ResourceQueryConstraint | undefined {
  return (input as { access?: ResourceQueryConstraint }).access;
}

/**
 * 摊平 SQL chunk 树收集列名。
 *
 * 不能对 Drizzle 的 `SQL` 直接 `JSON.stringify`（表与列互相引用，会抛循环结构错误），因此按
 * chunk 树递归取叶子列节点的名字。
 */
function collectColumnNames(node: unknown, names: string[] = []): string[] {
  if (node === null || typeof node !== "object") return names;
  const chunks = (node as { queryChunks?: readonly unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    for (const chunk of chunks) collectColumnNames(chunk, names);
    return names;
  }
  const candidate = node as { name?: unknown; dataType?: unknown; columnType?: unknown };
  if (typeof candidate.name === "string" && candidate.dataType !== undefined && candidate.columnType !== undefined) {
    names.push(candidate.name);
  }
  return names;
}

/** 端口入参里业务条件的列名集合。 */
function businessColumns(input: unknown): string[] {
  const where = (input as { businessWhere?: readonly unknown[] }).businessWhere ?? [];
  return where.flatMap((condition) => collectColumnNames(condition));
}

describe("AgentConfig 仓储下推", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）：写路径与无授权读
    // 路径直接打 DB，读路径则注入授权查询端口替身、不需要句柄。
    initializeAgentConfigModuleConfig();
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 列表与计数必须共用同一个授权条件：两次查询若各用一套条件，翻页会翻出可见集合之外。
  test("listReadable 把同一个授权条件同时交给列表与计数", async () => {
    const { query, listInputs, countInputs } = createRecordingQuery();
    const repository = createAgentConfigRepository(query);
    const constraint = testListConstraint();

    await repository.listReadable({
      access: constraint,
      order: AGENT_CONFIG_LIST_ORDER,
      limit: 10,
      offset: 20,
    });

    expect(accessOf(listInputs[0])).toBe(constraint);
    expect(accessOf(countInputs[0])).toBe(constraint);
    expect((listInputs[0] as { limit?: number }).limit).toBe(10);
    expect((listInputs[0] as { offset?: number }).offset).toBe(20);
    // 排序与分页下推到 SQL；计数不携带排序与分页，否则 total 会变成「当前页的行数」。
    expect((listInputs[0] as { businessOrder?: unknown }).businessOrder).toBe(AGENT_CONFIG_LIST_ORDER);
    expect(countInputs[0]).not.toHaveProperty("businessOrder");
    expect(countInputs[0]).not.toHaveProperty("limit");
  });

  // 行到视图之间没有过滤步骤：端口返回什么就返回什么，可见性完全由 SQL 决定。
  test("listReadable 原样返回端口结果，不在内存中过滤", async () => {
    const rows = [
      agentConfigRow({ id: "agent-a" }),
      agentConfigRow({ id: "agent-b", organizationId: "org-2", visibility: "public" }),
    ];
    const { query } = createRecordingQuery(rows);
    const repository = createAgentConfigRepository(query);

    const page = await repository.listReadable({ access: testListConstraint() });

    expect(page.items.map((row) => row.id)).toEqual(["agent-a", "agent-b"]);
    expect(page.total).toBe(2);
  });

  // 资源键定位必须把键里的组织作为 WHERE 条件下推：否则 `orgA/<orgB 的 agent id>` 会读到别人的 Agent。
  test("findReadableByKey 把键中的组织限定下推到 WHERE", async () => {
    const { query, findInputs } = createRecordingQuery([agentConfigRow({ organizationId: "org-source" })]);
    const repository = createAgentConfigRepository(query);
    const constraint = testListConstraint();

    await repository.findReadableByKey({
      organizationId: "org-source",
      resourceId: "agent-1",
      access: constraint,
    });

    const input = findInputs[0] as { access?: ResourceQueryConstraint; resourceId?: string };
    expect(input.access).toBe(constraint);
    expect(input.resourceId).toBe("agent-1");
    expect(businessColumns(findInputs[0])).toContain("organization_id");
  });

  // 详情只按资源 id 定位，组织归属完全由授权谓词判定，不得另加组织条件去「顺手」缩小范围。
  test("findReadableById 只下推资源 id 与授权条件", async () => {
    const { query, findInputs } = createRecordingQuery([agentConfigRow()]);
    const repository = createAgentConfigRepository(query);
    const constraint = testListConstraint();

    await repository.findReadableById({ resourceId: "agent-1", access: constraint });

    expect(accessOf(findInputs[0])).toBe(constraint);
    expect((findInputs[0] as { resourceId?: string }).resourceId).toBe("agent-1");
    expect(businessColumns(findInputs[0])).toEqual([]);
  });

  // 名称解析：给了组织就按组织限定，没给就让授权谓词决定可见集合（跨组织公开的也能命中）。
  test("findReadableByName 按是否给定组织决定 WHERE 条件", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createAgentConfigRepository(query);

    await repository.findReadableByName({ access: testListConstraint(), name: "demo", organizationId: "org-1" });
    await repository.findReadableByName({ access: testListConstraint(), name: "demo" });

    expect(businessColumns(listInputs[0])).toEqual(expect.arrayContaining(["name", "organization_id"]));
    expect(businessColumns(listInputs[1])).toContain("name");
    expect(businessColumns(listInputs[1])).not.toContain("organization_id");
    // 同名解析只取首行：同组织同名由唯一索引收敛，这里不得退回「取全部再挑」。
    expect((listInputs[0] as { limit?: number }).limit).toBe(1);
  });

  // 冲突分支只更新可写列：重复创建不得改主、不得重置公开受众，否则一次保存就会让资源漂移。
  test("create 的冲突更新不写归属列", async () => {
    let conflictSet: Record<string, unknown> | undefined;
    let insertedValues: Record<string, unknown> | undefined;
    stubDb({
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return {
            onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
              conflictSet = set;
              return { returning: async () => [{ id: "agent-1" }] };
            },
          };
        },
      }),
    });
    const { query } = createRecordingQuery();
    const repository = createAgentConfigRepository(query);

    const id = await repository.create({
      name: "demo",
      data: { description: "Demo", modelId: "11111111-1111-4111-8111-111111111111" },
      organizationId: "org-1",
      ownerUserId: "user-1",
      visibility: "public",
    });

    expect(id).toBe("agent-1");
    // 创建分支写入归属：归属列是创建期属性，唯一索引冲突（同组织同名）由 INSERT 侧的取值决定。
    expect(insertedValues).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      name: "demo",
      visibility: "public",
      description: "Demo",
    });
    for (const column of ["organizationId", "userId", "name", "visibility"]) {
      expect(conflictSet).not.toHaveProperty(column);
    }
    expect(conflictSet).toMatchObject({ description: "Demo" });
  });

  // 更新同样只写可写列：保存配置不得让资源换组织、换属主或改变公开受众。
  test("updateById 的写入负载不含归属列", async () => {
    let updatedSet: Record<string, unknown> | undefined;
    stubDb({
      update: () => ({
        set: (set: Record<string, unknown>) => {
          updatedSet = set;
          return { where: () => ({ returning: async () => [{ id: "agent-1" }] }) };
        },
      }),
    });
    const { query } = createRecordingQuery();
    const repository = createAgentConfigRepository(query);

    const updated = await repository.updateById({
      resourceId: "agent-1",
      data: { prompt: "新的提示词" },
    });

    expect(updated).toBe(true);
    expect(updatedSet).toMatchObject({ prompt: "新的提示词" });
    for (const column of ["organizationId", "userId", "name", "visibility"]) {
      expect(updatedSet).not.toHaveProperty(column);
    }
  });

  // 无授权读取是显式的旁路：命名里带 Unscoped，只允许系统路径（LaunchSpec 构建、Observer、acp-ws）调用。
  test("findByIdUnscoped 与 findByNameUnscoped 不经过授权端口", async () => {
    stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [agentConfigRow()] }) }) }) });
    const { query, listInputs, findInputs } = createRecordingQuery();
    const repository = createAgentConfigRepository(query);

    await repository.findByIdUnscoped({ resourceId: "agent-1" });
    await repository.findByNameUnscoped({ name: "demo", organizationId: "org-1" });

    expect(findInputs).toHaveLength(0);
    expect(listInputs).toHaveLength(0);
  });

  // 资源类型是注册与端口的连接键：注册里的类型若与端口入参不一致，绑定会落到另一张表。
  test("端口入参的 resourceType 与资源注册一致", async () => {
    const { query, listInputs, findInputs } = createRecordingQuery([agentConfigRow()]);
    const repository = createAgentConfigRepository(query);

    await repository.listReadable({ access: testListConstraint() });
    await repository.findReadableById({ resourceId: "agent-1", access: testListConstraint() });

    expect((listInputs[0] as { resourceType?: string }).resourceType).toBe(AGENT_CONFIG_RESOURCE_TYPE);
    expect((findInputs[0] as { resourceType?: string }).resourceType).toBe(AGENT_CONFIG_RESOURCE_TYPE);
    expect(AGENT_CONFIG_RESOURCE_TYPE).toBe(agentConfigResource.definition.type);
  });

  // 端口入参携带的就是注册里声明的物理绑定：把表换成别的表会让授权谓词落到错误的行上。
  test("端口入参携带资源注册声明的物理绑定", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createAgentConfigRepository(query);

    await repository.listReadable({ access: testListConstraint() });

    const input = listInputs[0] as { table?: unknown; columns?: unknown };
    expect(input.table).toBe(agentConfigResource.storage.table);
    expect(input.columns).toBe(agentConfigResource.storage.columns);
  });
});
