// agent-config 的「组织 → agent_config 归属投影」取数合同用例（消费方是 Observer 的系统人员树）。
//
// 为什么必须补：B7 把 `agent_config` 的表定义与**跨包直读**一起收敛回 owner——迁移前是 Observer 的
// `system-people-repository.ts` 直接 select 本表并在那边断言 SQL 形状。换接后消费方只依赖本包公开入口
// 返回的投影与顺序，于是「谓词、投影列、排序是否真的下推到 SQL」只能由 owner 侧直测：写错时消费方照样
// 返回 200，只是内容悄悄错（跨组织看到别人的智能体、名称与机器列错位、顺序随执行计划抖动）。
//
// 断言的是「交给数据库的那份条件与投影」，不是替身自己的过滤结果：替身刻意不解释 WHERE，它按 WHERE
// 携带的绑定参数反查组织 id 再返回该组织的行（见下方 `createOwnershipDbStub`）。
//
// chunk 读取助手（`collectColumnNames` / `collectParamValues`）取自本包 `__tests__/fixtures.ts`：它们
// 依赖 Drizzle `SQL` chunk 树的内部形状（表与列互相引用，不能 JSON.stringify），**跨包**共享会牵动其余
// 包的 Drizzle 升级，而跨包 import 对方的 `__tests__` 又被 §1.3 的公开出口约束禁止（只能经包根 /
// `/server` / `/web`）——同包内因此只有这一份定义，`agent-config-repository` /
// `agent-config-cross-package-queries` 与本文件共用（见 `fixtures.ts` 的「Drizzle 查询形状断言」段）。
// 同步说明：两个助手随实现在 B7 从 Observer 迁来（迁移前它们在
// `@fenix/resource-observer` 的 `system-people-repository.test.ts` / `system-people-db-stub.ts`，
// 两文件已随实现删除）。`collectColumnNames` 逐字一致；`collectParamValues` 在本包版本上**扩展过**
// ——本包自己的用例还会断言 `ilike` 的谓词（`ilike` 因 `shouldInlineParams` 把值内联为裸叶子，而
// `eq` 才包成 `Param`），因此这里同时收两种形态；Observer 留下的那份只服务它自己的替身反查组织，
// 只认 `Param` 叶子，两边不共享代码（跨包 import 对方的 `__tests__` 被公开出口约束禁止）。
// `orderDirection` 是本文件私有的第三个助手（旧用例只钉列名，未钉 asc/desc）：目前没有第二个消费者，
// 按「抽象延迟到第二个真实用例出现」暂不进 `fixtures.ts`。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type DbStub, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { type AgentConfigOwnershipRow, listAgentConfigsByOrganization } from "../server/repositories/agent-config";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import { collectColumnNames, collectParamValues } from "./fixtures";

// 被测模块就是 `./server` 入口 `export * from "./server/repositories/agent-config"` 的源模块；
// 包内用例按相对路径直连源模块（与 agent-config-site-app 等兄弟用例同形），消费方走包出口。

describe("agent-config 归属投影（listAgentConfigsByOrganization）", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 组织谓词必须下推到 SQL：按 org-1 查询时只应取到 org-1 的行，且绑定参数就是调用方给的组织 id。
  test("按组织下推 WHERE 谓词，不跨组织取行", async () => {
    const stub = createOwnershipDbStub({
      "org-1": [ownershipRow({ id: "agent-1" })],
      "org-2": [ownershipRow({ id: "agent-2" })],
    });
    stubDb(stub.db);

    const rows = await listAgentConfigsByOrganization("org-1");

    expect(rows.map((row) => row.id)).toEqual(["agent-1"]);
    expect(stub.whereClauses).toHaveLength(1);
    // 参数值钉住「用的是调用方的组织」；列名钉住「组织确实是 SQL 里的过滤列」——两者缺一都可能是假隔离。
    expect(collectParamValues(stub.whereClauses[0])).toEqual(["org-1"]);
    expect(collectColumnNames(stub.whereClauses[0])).toContain("organization_id");
  });

  // 投影只取展示与分组必需的列，且别名到真实列的映射正确（错位会让界面显示别人的名称/机器，不报错）。
  test("投影列与列名映射固定，不整行返回", async () => {
    const stub = createOwnershipDbStub({ "org-1": [ownershipRow()] });
    stubDb(stub.db);

    await listAgentConfigsByOrganization("org-1");

    expect(Object.keys(stub.projections[0]).sort()).toEqual([
      "description",
      "engineType",
      "id",
      "machineId",
      "name",
      "userId",
    ]);
    expect(
      Object.values(stub.projections[0])
        .flatMap((column) => collectColumnNames(column))
        .sort(),
    ).toEqual(["description", "engine_type", "id", "machine_id", "name", "user_id"]);
  });

  // 排序在 SQL 内完成（name → id，均为升序）：消费方按名称分组排序，若这里顺序不定，同一份数据在不同
  // 执行计划下输出会抖动，断言与界面都不可复现；方向写反则人名的展示顺序整体倒过来。
  test("排序下推到 SQL：name asc → id asc", async () => {
    const stub = createOwnershipDbStub({ "org-1": [ownershipRow()] });
    stubDb(stub.db);

    await listAgentConfigsByOrganization("org-1");

    expect(stub.orderByClauses).toHaveLength(1);
    expect(stub.orderByClauses[0]).toHaveLength(2);
    expect(collectColumnNames(stub.orderByClauses[0][0])).toEqual(["name"]);
    expect(collectColumnNames(stub.orderByClauses[0][1])).toEqual(["id"]);
    expect(orderDirection(stub.orderByClauses[0][0])).toBe("asc");
    expect(orderDirection(stub.orderByClauses[0][1])).toBe("asc");
  });

  // 可空列原样透传：description / machineId / engineType 为空时必须保持 null，不得补默认值或空串
  // （补值会把「未配置 machine」伪装成「已绑定机器」，人员树上的归属判断随之出错）。
  test("可空列原样返回 null，不补默认值", async () => {
    const stub = createOwnershipDbStub({
      "org-1": [ownershipRow({ description: null, machineId: null, engineType: null })],
    });
    stubDb(stub.db);

    const [row] = await listAgentConfigsByOrganization("org-1");

    expect(row).toEqual({
      id: "agent-1",
      userId: "user-1",
      name: "代码助手",
      description: null,
      machineId: null,
      engineType: null,
    });
  });

  // 组织没有任何智能体时返回空数组：空集合是合法状态，不能抛错也不能返回 undefined 让上层崩溃。
  test("组织无智能体时返回空数组", async () => {
    const stub = createOwnershipDbStub({});
    stubDb(stub.db);

    expect(await listAgentConfigsByOrganization("org-empty")).toEqual([]);
  });
});

/** 归属投影行的最小夹具；只列消费方真正渲染的列，未列出的按建表默认值补 null。 */
function ownershipRow(overrides: Partial<AgentConfigOwnershipRow> = {}): AgentConfigOwnershipRow {
  return {
    id: "agent-1",
    userId: "user-1",
    name: "代码助手",
    description: null,
    machineId: null,
    engineType: null,
    ...overrides,
  };
}

/** 取数替身：按组织返回行，同时记录投影、WHERE 与排序条件供断言。 */
interface OwnershipDbStub {
  readonly db: DbStub;
  /** `select()` 收到的投影映射，按调用顺序。 */
  readonly projections: Record<string, unknown>[];
  /** `where()` 收到的条件，按调用顺序。 */
  readonly whereClauses: unknown[];
  /** `orderBy()` 收到的排序键，按调用顺序。 */
  readonly orderByClauses: unknown[][];
}

/**
 * 构造 `agent_config` 归属查询的链式替身；`rowsByOrganization` 是各组织的存储内容。
 *
 * 未登记的组织返回空数组而不是抛错：组织的智能体集合本来就可能为空，抛错会把「空组织」这一合法状态
 * 变成用例的构造错误。
 */
function createOwnershipDbStub(rowsByOrganization: Record<string, AgentConfigOwnershipRow[]>): OwnershipDbStub {
  const projections: Record<string, unknown>[] = [];
  const whereClauses: unknown[] = [];
  const orderByClauses: unknown[][] = [];

  const db: DbStub = {
    select: (projection: Record<string, unknown>) => {
      projections.push(projection);
      return {
        from: () => ({
          where: (clause: unknown) => {
            whereClauses.push(clause);
            return {
              orderBy: async (...keys: unknown[]) => {
                orderByClauses.push(keys);
                const organizationId = collectParamValues(clause)[0];
                return organizationId ? (rowsByOrganization[organizationId] ?? []) : [];
              },
            };
          },
        }),
      };
    },
  };

  return { db, projections, whereClauses, orderByClauses };
}

/**
 * 取排序键的方向：`asc()` / `desc()` 生成的 `SQL` 里，方向是拼接的静态文本片段（`" asc"` / `" desc"`），
 * 由 `StringChunk` 承载——它的 `value` 是字符串**数组**，`collectColumnNames` 只取列节点名字、看不到它。
 *
 * 只收静态文本片段，排除 `Param` 叶子（后者的 `value` 是绑定值而非 SQL 文本，且带 `encoder`）。
 */
function orderDirection(node: unknown): string {
  const texts: string[] = [];
  const walk = (current: unknown): void => {
    if (typeof current === "string") {
      texts.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) walk(item);
      return;
    }
    if (current === null || typeof current !== "object") return;
    const chunks = (current as { queryChunks?: readonly unknown[] }).queryChunks;
    if (Array.isArray(chunks)) {
      for (const chunk of chunks) walk(chunk);
      return;
    }
    const candidate = current as { value?: unknown; encoder?: unknown };
    if (candidate.encoder !== undefined || candidate.value === undefined) return;
    if (typeof candidate.value === "string") texts.push(candidate.value);
    else if (Array.isArray(candidate.value)) {
      for (const part of candidate.value) if (typeof part === "string") texts.push(part);
    }
  };
  walk(node);
  return texts.join("").trim();
}
