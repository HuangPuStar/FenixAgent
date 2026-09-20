import { afterEach, describe, expect, test } from "bun:test";
import {
  type AuthorizedResourceQuery,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceQueryConstraint,
} from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { PROVIDER_RESOURCE_TYPE, providerResource } from "../server/access/provider-resource";
import {
  createProviderRepository,
  PROVIDER_LIST_ORDER,
  type ProviderQueryStorage,
  type ScopedProviderRow,
} from "../server/repositories/provider-resource";

/**
 * Provider 仓储的下推向导（对应计划 S5 的「下推断言」验收）。
 *
 * 本文件断言「授权条件如何到达 SQL」：仓储把 Facade 产出的**不透明条件**原样交给授权查询端口，
 * 自己不读取、不解释、也不在内存里过滤结果。真正的谓词编译与动作推导等价性由
 * `@fenix/access-control` 的 `authorization-consistency.test.ts` 覆盖（同一份策略函数同时驱动
 * 两者），这里补的是资源包这一侧的三件事：条件必须下推、列表与计数必须共用同一条件、组织限定
 * 必须进 WHERE 而不是查询后再比对。
 */

/** 构造平台上授权条件句柄；形状与 `DefaultAccessControl` 产出的条件一致（含私有载荷键）。 */
function testListConstraint(action: "read" | "use" = "read"): ResourceQueryConstraint {
  return {
    resourceType: providerResource.definition.type,
    action,
    provider: "test-access-control",
    [RESOURCE_QUERY_CONSTRAINT_PAYLOAD]: { action },
  };
}

/**
 * 装配 DB 替身并初始化应用基础设施。
 *
 * 仓储经 `getModelManagementDatabase()` 读平台契约里的进程级句柄，未初始化时读取即抛错，因此
 * 需要语句级替身的用例必须先走这一步。顺序即生产装配顺序：先登记句柄替身，再初始化基础设施
 * ——基础设施持有的是**引用**，反转顺序会让仓储读到未初始化的状态。本包不读模块配置，
 * `moduleConfigs` 留空。
 *
 * 前置 `resetAllStubs()` 而不是依赖 `afterEach`：初始化只允许一次，用例内先复位可让本文件单独
 * 执行与全量执行的行为一致（避免上一条用例留下的已初始化状态把本用例变成「重复初始化」错误）。
 */
function installDbStub(stub: Record<string, unknown>): void {
  resetAllStubs();
  stubDb(stub);
  initializeTestApplicationInfrastructure();
}

/** Provider 主表行的最小完整夹具；未列出的列按建表默认值补齐。 */
function providerRow(overrides: Partial<ScopedProviderRow> = {}): ScopedProviderRow {
  const organizationId = overrides.organizationId ?? "org-1";
  return {
    id: "provider-1",
    userId: "user-1",
    organizationId,
    name: "demo",
    displayName: null,
    kind: "direct",
    gatewayType: null,
    protocol: "openai",
    baseUrl: null,
    apiKey: null,
    extraOptions: null,
    visibility: "private",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: { organizationId, ownerUserId: "user-1", visibility: "private" },
    ...overrides,
  };
}

/** 记录端口入参的授权查询替身；返回行由用例给定。 */
function createRecordingQuery(rows: readonly ScopedProviderRow[] = []) {
  const listInputs: unknown[] = [];
  const countInputs: unknown[] = [];
  const findInputs: unknown[] = [];
  const query: AuthorizedResourceQuery<ProviderQueryStorage> = {
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

describe("Provider 仓储下推", () => {
  afterEach(() => {
    resetAllStubs();
  });

  // 列表与计数必须共用同一个授权条件：两次查询若各用一套条件，翻页会翻出可见集合之外。
  test("listReadable 把同一个授权条件同时交给列表与计数", async () => {
    const { query, listInputs, countInputs } = createRecordingQuery();
    const repository = createProviderRepository(query);
    const constraint = testListConstraint();

    await repository.listReadable({ access: constraint, order: PROVIDER_LIST_ORDER, limit: 10, offset: 20 });

    expect(accessOf(listInputs[0])).toBe(constraint);
    expect(accessOf(countInputs[0])).toBe(constraint);
    expect((listInputs[0] as { limit?: number }).limit).toBe(10);
    expect((listInputs[0] as { offset?: number }).offset).toBe(20);
  });

  // 行到视图之间没有过滤步骤：端口返回什么就返回什么，可见性完全由 SQL 决定。
  test("listReadable 原样返回端口结果，不在内存中过滤", async () => {
    const rows = [
      providerRow({ id: "provider-a" }),
      providerRow({ id: "provider-b", organizationId: "org-2", visibility: "public" }),
    ];
    const { query } = createRecordingQuery(rows);
    const repository = createProviderRepository(query);

    const page = await repository.listReadable({ access: testListConstraint() });

    expect(page.items.map((row) => row.id)).toEqual(["provider-a", "provider-b"]);
    expect(page.total).toBe(2);
  });

  // 资源键定位必须把键里的组织作为 WHERE 条件下推：否则 `orgA/<orgB 的资源 id>` 会读到别人的 Provider。
  test("findReadableByKey 把键中的组织限定下推到 WHERE", async () => {
    const { query, findInputs } = createRecordingQuery([providerRow({ organizationId: "org-source" })]);
    const repository = createProviderRepository(query);
    const constraint = testListConstraint();

    await repository.findReadableByKey({
      organizationId: "org-source",
      resourceId: "provider-1",
      access: constraint,
    });

    const input = findInputs[0] as { access?: ResourceQueryConstraint; resourceId?: string };
    expect(input.access).toBe(constraint);
    expect(input.resourceId).toBe("provider-1");
    expect(businessColumns(findInputs[0])).toContain("organization_id");
  });

  // 详情只按资源 id 定位，组织归属完全由授权谓词判定，不得另加组织条件去「顺手」缩小范围。
  test("findReadableById 只下推资源 id 与授权条件", async () => {
    const { query, findInputs } = createRecordingQuery([providerRow()]);
    const repository = createProviderRepository(query);
    const constraint = testListConstraint();

    await repository.findReadableById({ resourceId: "provider-1", access: constraint });

    expect(accessOf(findInputs[0])).toBe(constraint);
    expect((findInputs[0] as { resourceId?: string }).resourceId).toBe("provider-1");
    expect(businessColumns(findInputs[0])).toEqual([]);
  });

  // 名称解析：给了组织就按组织限定，没给就让授权谓词决定可见集合（跨组织公开的也能命中）。
  test("findReadableByName 按是否给定组织决定 WHERE 条件", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createProviderRepository(query);

    await repository.findReadableByName({ access: testListConstraint(), name: "demo", organizationId: "org-1" });
    await repository.findReadableByName({ access: testListConstraint(), name: "demo" });

    expect(businessColumns(listInputs[0])).toContain("organization_id");
    expect(businessColumns(listInputs[1])).not.toContain("organization_id");
    // 同名解析只取首行：同组织同名由唯一索引收敛，这里不得退回「取全部再挑」。
    expect((listInputs[0] as { limit?: number }).limit).toBe(1);
  });

  // 冲突分支只更新可写列：重复创建不得改主、不得重置公开受众，否则一次保存就会让资源漂移。
  test("create 的冲突更新不写归属列", async () => {
    let conflictSet: Record<string, unknown> | undefined;
    let insertedValues: Record<string, unknown> | undefined;
    installDbStub({
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          insertedValues = values;
          return {
            onConflictDoUpdate: ({ set }: { set: Record<string, unknown> }) => {
              conflictSet = set;
              return { returning: async () => [{ id: "provider-1" }] };
            },
          };
        },
      }),
    });
    const { query } = createRecordingQuery();
    const repository = createProviderRepository(query);

    const id = await repository.create({
      name: "demo",
      data: { displayName: "Demo", kind: "gateway" },
      organizationId: "org-1",
      ownerUserId: "user-1",
      visibility: "public",
    });

    expect(id).toBe("provider-1");
    // 创建分支写入归属：归属列是创建期属性，唯一索引冲突（同组织同名）由 INSERT 侧的取值决定。
    expect(insertedValues).toMatchObject({
      organizationId: "org-1",
      userId: "user-1",
      name: "demo",
      visibility: "public",
      displayName: "Demo",
      kind: "gateway",
    });
    for (const column of ["organizationId", "userId", "name", "visibility"]) {
      expect(conflictSet).not.toHaveProperty(column);
    }
    expect(conflictSet).toMatchObject({ displayName: "Demo", kind: "gateway" });
  });

  // 更新同样只写可写列：保存配置不得让资源换组织、换属主或改变公开受众。
  test("updateById 的写入负载不含归属列", async () => {
    let updatedSet: Record<string, unknown> | undefined;
    installDbStub({
      update: () => ({
        set: (set: Record<string, unknown>) => {
          updatedSet = set;
          return { where: () => ({ returning: async () => [{ id: "provider-1" }] }) };
        },
      }),
    });
    const { query } = createRecordingQuery();
    const repository = createProviderRepository(query);

    const updated = await repository.updateById({
      resourceId: "provider-1",
      data: { baseUrl: "https://example.test" },
    });

    expect(updated).toBe(true);
    expect(updatedSet).toMatchObject({ baseUrl: "https://example.test" });
    for (const column of ["organizationId", "userId", "name", "visibility"]) {
      expect(updatedSet).not.toHaveProperty(column);
    }
  });

  // 无授权读取是显式的旁路：命名里带 Unscoped，只允许系统路径（模型网关同步、启动装配）调用。
  test("findByIdUnscoped 走无授权查询且不经过授权端口", async () => {
    const row = providerRow();
    installDbStub({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }) });
    const { query, findInputs, listInputs } = createRecordingQuery();
    const repository = createProviderRepository(query);

    const found = await repository.findByIdUnscoped({ resourceId: "provider-1" });

    expect(found?.id).toBe("provider-1");
    expect(findInputs).toHaveLength(0);
    expect(listInputs).toHaveLength(0);
  });

  // 资源类型是注册与端口的连接键：注册里的类型若与端口入参不一致，绑定会落到另一张表。
  test("端口入参的 resourceType 与资源注册一致", async () => {
    const { query, listInputs, findInputs } = createRecordingQuery([providerRow()]);
    const repository = createProviderRepository(query);

    await repository.listReadable({ access: testListConstraint() });
    await repository.findReadableById({ resourceId: "provider-1", access: testListConstraint() });

    expect((listInputs[0] as { resourceType?: string }).resourceType).toBe(PROVIDER_RESOURCE_TYPE);
    expect((findInputs[0] as { resourceType?: string }).resourceType).toBe(PROVIDER_RESOURCE_TYPE);
    expect(PROVIDER_RESOURCE_TYPE).toBe(providerResource.definition.type);
  });

  // 端口入参携带的就是注册里声明的物理绑定：把表换成别的表会让授权谓词落到错误的行上。
  test("端口入参携带资源注册声明的物理绑定", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createProviderRepository(query);

    await repository.listReadable({ access: testListConstraint() });

    const input = listInputs[0] as { table?: unknown; columns?: unknown };
    expect(input.table).toBe(providerResource.storage.table);
    expect(input.columns).toBe(providerResource.storage.columns);
  });

  // 存储类型收窄是本包对端口的实例化：这里断言它确实指向 Provider 行与 Drizzle 表/列。
  test("ProviderQueryStorage 指向 Provider 主表", () => {
    const storage: ProviderQueryStorage["row"] = providerRow();

    expect(storage.organizationId).toBe("org-1");
    expect(providerResource.storage.columns.visibility).toBeDefined();
  });
});
