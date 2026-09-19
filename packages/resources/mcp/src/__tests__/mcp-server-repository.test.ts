import { describe, expect, test } from "bun:test";
import type { AuthorizedResourceQuery, ResourceQueryConstraint } from "@fenix/platform-sdk";
import { mcpServer } from "@server/db/schema";
import { asc } from "drizzle-orm";
import { MCP_SERVER_RESOURCE_TYPE } from "../server/access/mcp-server-resource";
import {
  createMcpServerRepository,
  type McpServerQueryStorage,
  type ScopedMcpServerRow,
} from "../server/repositories/mcp-server";
import { scopedServer, testListConstraint } from "./fixtures";

/**
 * MCP Server 仓储的下推向导。
 *
 * 本文件断言的是「授权条件如何到达 SQL」：仓储只把 Facade 产出的**不透明条件**原样交给授权查询
 * 端口，自己不读取、不解释、更不在内存里过滤结果。谓词本身的语义（动作推导与 SQL 谓词等价）在
 * `packages/platform/access-control` 的 `authorization-consistency.test.ts` 里用离线谓词等价验证，
 * 不在本文件重复；这里补的是资源包这一侧：条件必须下推、计数与列表必须共用同一条件、组织限定必须
 * 进 WHERE。
 */

/** 记录调用的授权查询端口替身；返回行由用例给定。 */
function createRecordingQuery(rows: readonly ScopedMcpServerRow[] = []) {
  const listInputs: unknown[] = [];
  const countInputs: unknown[] = [];
  const findInputs: unknown[] = [];
  const query: AuthorizedResourceQuery<McpServerQueryStorage> = {
    list: async (input) => {
      listInputs.push(input);
      return { items: [...rows] };
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

/** 从端口入参里取出授权条件，断言"传的是同一个句柄"而不是被复制或重写过的形状。 */
function accessOf(input: unknown): ResourceQueryConstraint | undefined {
  return (input as { access?: ResourceQueryConstraint }).access;
}

/**
 * 摊平 SQL chunk 树收集列名。
 *
 * 不能对 Drizzle 的 `SQL` 直接 `JSON.stringify`（表与列互相引用，会抛循环结构错误），因此按
 * chunk 树递归取叶子列节点的名字。与 `@fenix/resource-skill` 的同名测试助手刻意各自保留一份：
 * 它依赖 Drizzle chunk 的内部形状，两个包对"下推"的断言意图也不同，抽到公共测试包会让任一侧的
 * 调整都牵动另一侧的用例。
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

describe("MCP Server 仓储下推", () => {
  // 列表与计数必须共用同一个授权条件：两次查询若各用一套条件，翻页会翻出可见集合之外。
  test("listReadable 把同一个授权条件同时交给列表与计数", async () => {
    const { query, listInputs, countInputs } = createRecordingQuery();
    const repository = createMcpServerRepository(query);
    const constraint = testListConstraint();

    await repository.listReadable({ access: constraint, limit: 10, offset: 20 });

    expect(accessOf(listInputs[0])).toBe(constraint);
    expect(accessOf(countInputs[0])).toBe(constraint);
    // 计数不得带上分页：它算的是整个可见集合的基数，不是当前页的长度。
    expect((listInputs[0] as { limit?: number }).limit).toBe(10);
    expect((listInputs[0] as { offset?: number }).offset).toBe(20);
    expect((countInputs[0] as { limit?: number }).limit).toBeUndefined();
    expect((countInputs[0] as { offset?: number }).offset).toBeUndefined();
  });

  // 行到视图之间没有过滤步骤：端口返回什么就返回什么，可见性完全由 SQL 决定。
  test("listReadable 原样返回端口结果，不在内存中过滤", async () => {
    const rows = [scopedServer({ id: "mcp-a" }), scopedServer({ id: "mcp-b", organizationId: "org-2" })];
    const { query } = createRecordingQuery(rows);
    const repository = createMcpServerRepository(query);

    const page = await repository.listReadable({ access: testListConstraint() });

    expect(page.items.map((row) => row.id)).toEqual(["mcp-a", "mcp-b"]);
    expect(page.total).toBe(2);
  });

  // 端口必须收到注册表里那一个资源类型与物理绑定：写错资源类型会让授权谓词落到别的资源定义上。
  test("listReadable 以注册的资源类型与绑定查询", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createMcpServerRepository(query);

    await repository.listReadable({ access: testListConstraint() });

    const input = listInputs[0] as { resourceType?: string; columns?: { id?: unknown } };
    expect(input.resourceType).toBe(MCP_SERVER_RESOURCE_TYPE);
    expect(input.columns?.id).toBeDefined();
  });

  // 业务排序由调用方给出，仓储不得自造排序：列表顺序必须与授权谓词在同一条件集内可预期。
  test("listReadable 仅透传调用方给出的业务排序", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createMcpServerRepository(query);

    await repository.listReadable({ access: testListConstraint() });
    expect((listInputs[0] as { businessOrder?: unknown }).businessOrder).toBeUndefined();

    const order = [asc(mcpServer.name)];
    await repository.listReadable({ access: testListConstraint(), order });
    expect((listInputs[1] as { businessOrder?: unknown }).businessOrder).toBe(order);
  });

  // 资源键定位必须把键里的组织作为 WHERE 条件下推：否则 `orgA/<orgB 的资源 id>` 会读到别人的资源。
  test("findReadableByKey 把键中的组织限定下推到 WHERE", async () => {
    const { query, findInputs } = createRecordingQuery([scopedServer({ organizationId: "org-source" })]);
    const repository = createMcpServerRepository(query);
    const constraint = testListConstraint();

    await repository.findReadableByKey({ organizationId: "org-source", resourceId: "mcp-1", access: constraint });

    const input = findInputs[0] as { access?: ResourceQueryConstraint; resourceId?: string };
    expect(input.access).toBe(constraint);
    expect(input.resourceId).toBe("mcp-1");
    // 组织限定必须以条件形式出现（而非查询后再比对），列名在 SQL 片段里可辨认。
    expect(businessColumns(findInputs[0])).toContain("organization_id");
  });

  // 名称解析：给了组织就按组织限定，没给就让授权谓词决定可见集合（跨组织公开的也能命中）。
  test("findReadableByName 按是否给定组织决定 WHERE 条件", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createMcpServerRepository(query);

    await repository.findReadableByName({ access: testListConstraint(), name: "demo", organizationId: "org-1" });
    await repository.findReadableByName({ access: testListConstraint(), name: "demo" });

    expect(businessColumns(listInputs[0])).toContain("organization_id");
    expect(businessColumns(listInputs[1])).not.toContain("organization_id");
    // 名称是唯一键的一部分，命中一行即止，不把同名行全部读回内存再挑。
    expect((listInputs[0] as { limit?: number }).limit).toBe(1);
    expect((listInputs[1] as { limit?: number }).limit).toBe(1);
  });

  // 详情入口只交出资源 ID 与授权条件：仓储不得自行补组织条件，否则跨组织公开资源会被误判不可见。
  test("findReadableById 只交出资源 ID 与授权条件", async () => {
    const { query, findInputs } = createRecordingQuery([scopedServer()]);
    const repository = createMcpServerRepository(query);
    const constraint = testListConstraint();

    const row = await repository.findReadableById({ access: constraint, resourceId: "mcp-1" });

    expect(row?.id).toBe("mcp-1");
    expect(accessOf(findInputs[0])).toBe(constraint);
    expect((findInputs[0] as { businessWhere?: readonly unknown[] }).businessWhere).toBeUndefined();
  });

  // 受控读取不带 `use` 之外的动作推断：句柄的动作由 Facade 决定，仓储只透传。
  test("受控读取原样透传动作不同的条件句柄", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createMcpServerRepository(query);
    const constraint = testListConstraint("use");

    await repository.listReadable({ access: constraint });

    expect(accessOf(listInputs[0])).toBe(constraint);
    expect(accessOf(listInputs[0])?.action).toBe("use");
  });
});
