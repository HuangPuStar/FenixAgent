// Machine 注册表 Facade 的归属语义用例：门面把 actor 缩成显式范围（`MachineScope`），服务把该范围编译成
// 交给数据库的 WHERE 条件。本文件要证明的正是「哪些行读得到 / 改得到」。
//
// 为什么不用「SQL 里出现过 organization_id 与 user_id」这类断言：列名断言分不清 `and` 与 `or`，也分不清
// 哪个值落在哪一列——把 `user_id` 的比较换成 `organization_id`（同一份参数集合）它照样通过。这里改为把
// 服务真正交给数据库的条件取回来，用一个只认 `and` / `or` / `=` / `is null` 的离线求值器对夹具行求值，
// 断言读到的行集合；求值器遇到未知算子直接抛错，口径改写必须同步扩展本文件，而不是让用例静默通过。
//
// 与 `round39-registry-service.test.ts` 的分工：那里的用例用显式 `MachineScope` 驱动服务，证明「拿到某个
// 范围后做的事对不对」；本文件证明「交给服务的那个范围确实来自 actor」，且该范围的**读语义**正确——
// 跨组织不可达、同组织他人不可达、组织级/系统级机器对成员可见。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { DbStub } from "@fenix/platform-sdk/testing";
import { resetAllStubs, stubDb, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { machine, registryEvent } from "@fenix/resource-machine/db";
import { type MachineActor, machineRegistryFacade } from "../server/facades/machine-registry-facade";
import { initializeMachineModuleConfig, stubMachineAgentConfig } from "../server/testing";

/** 调用方：组织 a 的成员 user-a。 */
const ACTOR: MachineActor = { organizationId: "org-a", userId: "user-a" };

/**
 * 机器夹具：只有隔离判据与断言用到的列。
 *
 * `organizationId` / `userId` 为 null 表示部署级（系统）机器——它对所有组织可见，是本文件里唯一允许
 * 越出组织边界的行，因此必须显式摆出来，避免把「跨组织不可达」写成过宽的断言。
 */
interface MachineFixture {
  readonly id: string;
  readonly organizationId: string | null;
  readonly userId: string | null;
  /** 机器类型：列表默认按 `machine` 过滤，夹具必须显式建模，否则条件求值会因缺列而全不命中。 */
  readonly type: string;
  readonly status: string;
  readonly name: string;
}

/** 事件夹具：事件的可见性继承其机器，不单独判定。 */
interface EventFixture {
  readonly id: string;
  readonly machineId: string;
}

/** 夹具全集：组织内本人 / 组织内他人 / 组织级 / 跨组织 / 跨组织组织级 / 系统级。 */
function machineFixtures(): MachineFixture[] {
  return [
    {
      id: "mach-a-owner",
      organizationId: "org-a",
      userId: "user-a",
      type: "machine",
      status: "offline",
      name: "本人机器",
    },
    {
      id: "mach-a-other",
      organizationId: "org-a",
      userId: "user-b",
      type: "machine",
      status: "offline",
      name: "同事机器",
    },
    {
      id: "mach-a-shared",
      organizationId: "org-a",
      userId: null,
      type: "machine",
      status: "offline",
      name: "组织级机器",
    },
    {
      id: "mach-b-owner",
      organizationId: "org-b",
      userId: "user-b",
      type: "machine",
      status: "offline",
      name: "他组织机器",
    },
    {
      id: "mach-b-shared",
      organizationId: "org-b",
      userId: null,
      type: "machine",
      status: "offline",
      name: "他组织级机器",
    },
    { id: "mach-system", organizationId: null, userId: null, type: "machine", status: "offline", name: "部署兜底机器" },
  ];
}

// ── 条件的离线求值 ──
//
// 求值器解释 Drizzle 的 chunk 树（条件编译后的真实形状），而不是在替身里硬编码一份行过滤——后者只能证明
// 替身自己的过滤是对的。列名与参数值都从 chunk 树里读，因此条件一改（例如去掉 `user_id` 那一支），行的
// 判定结果就变，断言跟着红。

/** 记号：`open` / `close` 为括号，`and` / `or` 为连接词，`compare` 已把列、算子与绑定值收在一起。 */
type ConditionToken =
  | { readonly kind: "open" | "close" | "and" | "or" }
  | { readonly kind: "compare"; readonly column: string; readonly value: unknown }
  | { readonly kind: "isNull"; readonly column: string };

/** 语法树。 */
type ConditionNode =
  | { readonly kind: "and" | "or"; readonly children: readonly ConditionNode[] }
  | { readonly kind: "compare"; readonly column: string; readonly value: unknown }
  | { readonly kind: "isNull"; readonly column: string };

/** Drizzle 的 `SQL` 节点：条件树的唯一复合结构。 */
function sqlChunksOf(node: unknown): readonly unknown[] | undefined {
  const chunks = (node as { queryChunks?: unknown } | null)?.queryChunks;
  return Array.isArray(chunks) ? chunks : undefined;
}

/** SQL 文本节点（`StringChunk`）；列与参数节点的 `value` 不是字符串数组。 */
function textOf(node: unknown): string | undefined {
  const value = (node as { value?: unknown } | null)?.value;
  return Array.isArray(value) && typeof value[0] === "string" ? value.join("") : undefined;
}

/** 列节点：靠 `name` + `dataType` 辨认（与平台测试助手同形）。 */
function columnOf(node: unknown): string | undefined {
  const candidate = node as { name?: unknown; dataType?: unknown } | null;
  const name = candidate?.name;
  return typeof name === "string" && candidate?.dataType !== undefined ? name : undefined;
}

function pushTextToken(text: string, tokens: ConditionToken[]): void {
  const trimmed = text.trim();
  if (trimmed === "") return;
  if (trimmed === "(") tokens.push({ kind: "open" });
  else if (trimmed === ")") tokens.push({ kind: "close" });
  else if (trimmed === "and") tokens.push({ kind: "and" });
  else if (trimmed === "or") tokens.push({ kind: "or" });
  else throw new Error(`机器归属条件求值器不支持的记号：${trimmed}`);
}

/** 摊平 chunk 树：列之后紧跟算子文本（`=` 或 `is null`），比较算子在摊平期完成识别。 */
function tokenizeCondition(chunks: readonly unknown[], tokens: ConditionToken[]): void {
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    if (chunk === undefined || chunk === null) continue;
    const nested = sqlChunksOf(chunk);
    if (nested !== undefined) {
      tokenizeCondition(nested, tokens);
      continue;
    }
    const column = columnOf(chunk);
    if (column !== undefined) {
      const operator = textOf(chunks[index + 1])?.trim();
      if (operator === "is null") {
        tokens.push({ kind: "isNull", column });
        index += 1;
        continue;
      }
      if (operator !== "=") throw new Error(`机器归属条件求值器不支持的运算符：${operator}`);
      const param = chunks[index + 2] as { value?: unknown; encoder?: unknown } | undefined;
      if (param?.encoder === undefined) throw new Error("机器归属条件求值器：比较算子右侧不是绑定参数");
      tokens.push({ kind: "compare", column, value: param.value });
      index += 2;
      continue;
    }
    const text = textOf(chunk);
    if (text === undefined) throw new Error("机器归属条件求值器不支持的 chunk");
    pushTextToken(text, tokens);
  }
}

/** 递归下降解析：`or` 优先级最低，括号与比较为基本单元。 */
function parseCondition(tokens: readonly ConditionToken[]): ConditionNode {
  let cursor = 0;
  const parsePrimary = (): ConditionNode => {
    const token = tokens[cursor];
    if (token === undefined) throw new Error("机器归属条件求值器：表达式提前结束");
    if (token.kind === "open") {
      cursor += 1;
      const node = parseOr();
      if (tokens[cursor]?.kind !== "close") throw new Error("机器归属条件求值器：括号未闭合");
      cursor += 1;
      return node;
    }
    if (token.kind === "compare" || token.kind === "isNull") {
      cursor += 1;
      return token;
    }
    throw new Error(`机器归属条件求值器：意外的记号 ${token.kind}`);
  };
  const parseAnd = (): ConditionNode => {
    const children: ConditionNode[] = [parsePrimary()];
    while (tokens[cursor]?.kind === "and") {
      cursor += 1;
      children.push(parsePrimary());
    }
    return children.length === 1 ? (children[0] as ConditionNode) : { kind: "and", children };
  };
  const parseOr = (): ConditionNode => {
    const children: ConditionNode[] = [parseAnd()];
    while (tokens[cursor]?.kind === "or") {
      cursor += 1;
      children.push(parseAnd());
    }
    return children.length === 1 ? (children[0] as ConditionNode) : { kind: "or", children };
  };

  const node = parseOr();
  if (cursor !== tokens.length) throw new Error("机器归属条件求值器：存在未消费的记号");
  return node;
}

function evaluateCondition(node: ConditionNode, row: Readonly<Record<string, unknown>>): boolean {
  if (node.kind === "and") return node.children.every((child) => evaluateCondition(child, row));
  if (node.kind === "or") return node.children.some((child) => evaluateCondition(child, row));
  // 夹具未建模的列直接抛错：返回 false 会让「条件里多了一列」表现为「一条都读不到」，用例会以另一种
  // 面貌变红而掩盖真实原因（本文件第一次运行时就是这样发现夹具漏了 `type`）。
  if (!(node.column in row)) throw new Error(`机器归属条件求值器：夹具行缺少列 ${node.column}`);
  const actual = row[node.column];
  if (node.kind === "isNull") return actual === null || actual === undefined;
  // SQL 三值逻辑：与 NULL 的比较不为真，因此列缺失或为 null 时一律不命中。
  if (actual === null || actual === undefined) return false;
  return actual === node.value;
}

/** 夹具行 → 求值用的视图（键为 Drizzle 列名）。 */
function machineView(row: MachineFixture): Record<string, unknown> {
  return {
    id: row.id,
    organization_id: row.organizationId,
    user_id: row.userId,
    type: row.type,
    status: row.status,
  };
}

/**
 * 机器域 DB 替身。
 *
 * 只实现本包仓储/服务用到的链（读的 `select/from/where` 三种收尾、写路径的 `insert/update/delete`）。
 * `where` 收到的条件用上面的求值器解释后**真的过滤夹具行**：这样用例断言的是「哪些行可达」，而不是
 * 「条件长什么样」。未登记的列/算子会让求值器抛错，替身不静默放行。
 */
function createMachineDbStub(machines: MachineFixture[], events: EventFixture[]) {
  const whereClauses: unknown[] = [];
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];

  /** 按条件求值取子集；条件里出现未登记的列/算子时求值器直接抛错，替身不静默放行。 */
  const matches = (clause: unknown, view: Record<string, unknown>): boolean => {
    const tokens: ConditionToken[] = [];
    tokenizeCondition([clause], tokens);
    return evaluateCondition(parseCondition(tokens), view);
  };

  const db: DbStub = {
    select: (projection?: unknown) => ({
      from: (table: unknown) => ({
        where: (clause: unknown) => {
          whereClauses.push(clause);
          const isCount = typeof projection === "object" && projection !== null && "count" in projection;
          const rows =
            table === machine
              ? machines.filter((row) => matches(clause, machineView(row)))
              : table === registryEvent
                ? events.filter((row) => matches(clause, { id: row.id, machine_id: row.machineId }))
                : (() => {
                    throw new Error("机器域替身：未登记的表");
                  })();
          const result = isCount ? [{ count: rows.length }] : rows;
          // 两种收尾方式共用一份结果：计数查询直接 `await .where(...)`（Drizzle 的链式查询对象本身可 await），
          // 列表与详情则以 `orderBy → limit → offset` / `limit` 收尾。挂在一个 Promise 上同时满足两者。
          return Object.assign(Promise.resolve(result), {
            orderBy: () => ({ limit: () => ({ offset: async () => result }) }),
            limit: async () => result,
          });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (table !== machine && table !== registryEvent) throw new Error("机器域替身：未登记的表");
        inserts.push(values);
      },
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: async (clause: unknown) => {
          whereClauses.push(clause);
          for (const row of machines) {
            if (matches(clause, machineView(row))) {
              updates.push({ id: row.id, patch });
              Object.assign(row, patch);
            }
          }
        },
      }),
    }),
    delete: () => ({
      where: async (clause: unknown) => {
        whereClauses.push(clause);
        for (let index = machines.length - 1; index >= 0; index -= 1) {
          const row = machines[index] as MachineFixture;
          if (matches(clause, machineView(row))) machines.splice(index, 1);
        }
      },
    }),
  };

  return { db, whereClauses, inserts, updates, machines, events };
}

describe("Machine 注册表 Facade 的归属语义", () => {
  let stub: ReturnType<typeof createMachineDbStub>;

  beforeEach(() => {
    stub = createMachineDbStub(machineFixtures(), [{ id: "evt-1", machineId: "mach-a-owner" }]);
    initializeMachineModuleConfig();
    stubDb(stub.db);
    // 删除路径的两个外部判定：Agent 配置引用（宿主注入端口）与组织默认引擎（身份目录）。两者都答「无引用」，
    // 让本文件聚焦归属语义本身。
    stubMachineAgentConfig({
      getExecutionNode: async () => null,
      isAgentConfigBoundToMachine: async () => false,
      bindMachineIdByAgentName: async () => {},
    });
    stubIdentityDirectory({ getOrganization: async () => undefined });
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 列表：本组织本人机器、本组织组织级机器与部署兜底机器可见；跨组织（含有属主与无属主）与同组织他人不可见。
  test("list 只返回本组织本人与组织级/系统级机器", async () => {
    const result = await machineRegistryFacade.list(ACTOR, {});

    expect(result.data.map((row) => row.id)).toEqual(["mach-a-owner", "mach-a-shared", "mach-system"]);
    expect(result.total).toBe(3);
  });

  // 详情：跨组织与同组织他人返回 null（不存在与不可见同形，不给出可探测的差异）。
  test("get 对他组织的机器与同组织他人的机器一律返回 null", async () => {
    expect((await machineRegistryFacade.get(ACTOR, "mach-a-owner"))?.id).toBe("mach-a-owner");
    expect(await machineRegistryFacade.get(ACTOR, "mach-a-other")).toBeNull();
    expect(await machineRegistryFacade.get(ACTOR, "mach-b-owner")).toBeNull();
    expect(await machineRegistryFacade.get(ACTOR, "mach-b-shared")).toBeNull();
  });

  // 事件历史：机器不可见时返回空分页，不泄漏他人机器的生命周期数据。
  test("listEvents 对不可见机器返回空分页", async () => {
    await expect(
      machineRegistryFacade.listEvents(ACTOR, "mach-a-owner", { limit: 10, offset: 0 }),
    ).resolves.toMatchObject({ total: 1 });
    await expect(machineRegistryFacade.listEvents(ACTOR, "mach-b-owner", { limit: 10, offset: 0 })).resolves.toEqual({
      data: [],
      total: 0,
    });
    await expect(machineRegistryFacade.listEvents(ACTOR, "mach-a-other", { limit: 10, offset: 0 })).resolves.toEqual({
      data: [],
      total: 0,
    });
  });

  // 创建：组织归属取自 actor，属主留空（机器归组织而非个人）；请求数据无法影响归属。
  test("create 用 actor 的组织落成归属", async () => {
    const created = await machineRegistryFacade.create(ACTOR, { name: "新机器" });

    expect(created).toMatchObject({ name: "新机器", status: "pending" });
    expect(stub.inserts).toEqual([
      expect.objectContaining({ organizationId: "org-a", userId: null, name: "新机器", type: "machine" }),
    ]);
  });

  // 更新：本人机器可改；同组织他人与他组织的机器抛「not found」，且他人的行**未被改动**。
  test("update 拒绝跨组织与同组织他人，且不留下写入", async () => {
    await expect(machineRegistryFacade.update(ACTOR, "mach-a-owner", { name: "改名后" })).resolves.toMatchObject({
      name: "改名后",
    });

    await expect(machineRegistryFacade.update(ACTOR, "mach-a-other", { name: "越权改名" })).rejects.toThrow(
      /not found/,
    );
    await expect(machineRegistryFacade.update(ACTOR, "mach-b-owner", { name: "越权改名" })).rejects.toThrow(
      /not found/,
    );

    // 语义断言：越权那两次没有落到任何一行（`updates` 里只有本人那一次）。
    expect(stub.updates).toEqual([{ id: "mach-a-owner", patch: expect.objectContaining({ name: "改名后" }) }]);
    expect(stub.machines.find((row) => row.id === "mach-a-other")?.name).toBe("同事机器");
    expect(stub.machines.find((row) => row.id === "mach-b-owner")?.name).toBe("他组织机器");
  });

  // 删除：不可见的机器抛「not found」且记录仍在；本人机器可删（删除条件同样带归属）。
  test("remove 拒绝不可见机器，本人机器可删", async () => {
    await expect(machineRegistryFacade.remove(ACTOR, "mach-a-other")).rejects.toThrow(/not found/);
    await expect(machineRegistryFacade.remove(ACTOR, "mach-b-owner")).rejects.toThrow(/not found/);
    expect(stub.machines.some((row) => row.id === "mach-a-other")).toBe(true);
    expect(stub.machines.some((row) => row.id === "mach-b-owner")).toBe(true);

    await expect(machineRegistryFacade.remove(ACTOR, "mach-a-owner")).resolves.toEqual({ deleted: true });
    expect(stub.machines.some((row) => row.id === "mach-a-owner")).toBe(false);
  });
});
