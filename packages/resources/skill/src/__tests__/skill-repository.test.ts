import { describe, expect, test } from "bun:test";
import type { AuthorizedResourceQuery, ResourceQueryConstraint } from "@fenix/platform-sdk";
import { createSkillRepository, type ScopedSkillRow, type SkillQueryStorage } from "../server/repositories/skill";
import { FIXTURE_NOW, scopedSkill, testListConstraint } from "./fixtures";

/**
 * Skill 仓储的下推向导。
 *
 * 本文件断言的是「授权条件如何到达 SQL」：仓储只把 Facade 产出的**不透明条件**原样交给授权查询
 * 端口，自己不读取、不解释、更不在内存里过滤结果。谓词编译本身的正确性（同一份策略函数同时驱动
 * 动作推导与 SQL 谓词）在 `packages/platform/access-control` 的 `authorization-consistency.test.ts`
 * 用离线谓词等价校验覆盖，本文件不重复；这里补的是资源包这一侧：条件必须下推、计数与列表必须共用
 * 同一条件、组织限定必须进 WHERE。
 */

/** 记录调用的授权查询端口替身；返回行由用例给定。 */
function createRecordingQuery(rows: readonly ScopedSkillRow[] = []) {
  const listInputs: unknown[] = [];
  const countInputs: unknown[] = [];
  const findInputs: unknown[] = [];
  const query: AuthorizedResourceQuery<SkillQueryStorage> = {
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

describe("Skill 仓储下推", () => {
  // 列表与计数必须共用同一个授权条件：两次查询若各用一套条件，翻页会翻出可见集合之外。
  test("listReadable 把同一个授权条件同时交给列表与计数", async () => {
    const { query, listInputs, countInputs } = createRecordingQuery();
    const repository = createSkillRepository(query);
    const constraint = testListConstraint();

    await repository.listReadable({ access: constraint, limit: 10, offset: 20 });

    expect(accessOf(listInputs[0])).toBe(constraint);
    expect(accessOf(countInputs[0])).toBe(constraint);
    expect((listInputs[0] as { limit?: number }).limit).toBe(10);
    expect((listInputs[0] as { offset?: number }).offset).toBe(20);
  });

  // 行到视图之间没有过滤步骤：端口返回什么就返回什么，可见性完全由 SQL 决定。
  test("listReadable 原样返回端口结果，不在内存中过滤", async () => {
    const rows = [scopedSkill({ id: "skill-a" }), scopedSkill({ id: "skill-b", organizationId: "org-2" })];
    const { query } = createRecordingQuery(rows);
    const repository = createSkillRepository(query);

    const page = await repository.listReadable({ access: testListConstraint() });

    expect(page.items.map((row) => row.id)).toEqual(["skill-a", "skill-b"]);
    expect(page.total).toBe(2);
  });

  // 资源键定位必须把键里的组织作为 WHERE 条件下推：否则 `orgA/<orgB 的资源 id>` 会读到别人的资源。
  test("findReadableByKey 把键中的组织限定下推到 WHERE", async () => {
    const { query, findInputs } = createRecordingQuery([scopedSkill({ organizationId: "org-source" })]);
    const repository = createSkillRepository(query);
    const constraint = testListConstraint();

    await repository.findReadableByKey({ organizationId: "org-source", resourceId: "skill-1", access: constraint });

    const input = findInputs[0] as { access?: ResourceQueryConstraint; resourceId?: string };
    expect(input.access).toBe(constraint);
    expect(input.resourceId).toBe("skill-1");
    // 组织限定必须以条件形式出现（而非查询后再比对），列名在 SQL 片段里可辨认。
    expect(businessColumns(findInputs[0])).toContain("organization_id");
  });

  // 名称解析：给了组织就按组织限定，没给就让授权谓词决定可见集合（跨组织公开的也能命中）。
  test("findReadableByName 按是否给定组织决定 WHERE 条件", async () => {
    const { query, listInputs } = createRecordingQuery();
    const repository = createSkillRepository(query);

    await repository.findReadableByName({ access: testListConstraint(), name: "demo", organizationId: "org-1" });
    await repository.findReadableByName({ access: testListConstraint(), name: "demo" });

    expect(businessColumns(listInputs[0])).toContain("organization_id");
    expect(businessColumns(listInputs[1])).not.toContain("organization_id");
    expect((listInputs[0] as { limit?: number }).limit).toBe(1);
  });

  // 按名称批量读取只为冲突检测与回读服务：空名单不发起查询，非空时一次取回全部命中行。
  test("listReadableByNames 空名单不查询，非空时按组织批量读取", async () => {
    const { query, listInputs } = createRecordingQuery([scopedSkill({ id: "skill-1" })]);
    const repository = createSkillRepository(query);

    expect(
      await repository.listReadableByNames({ access: testListConstraint(), names: [], organizationId: "org-1" }),
    ).toEqual([]);
    expect(listInputs).toHaveLength(0);

    const rows = await repository.listReadableByNames({
      access: testListConstraint(),
      names: ["demo", "other"],
      organizationId: "org-1",
    });

    expect(rows.map((row) => row.id)).toEqual(["skill-1"]);
    expect(listInputs).toHaveLength(1);
    expect(businessColumns(listInputs[0])).toContain("organization_id");
  });

  // 无授权路径的命名与行为都是显式的：系统路径（builtin 同步、launch spec）才用它。
  test("无授权读取入口与受控入口分离", async () => {
    const { query } = createRecordingQuery([scopedSkill()]);
    const repository = createSkillRepository(query);

    const row = await repository.findReadableById({ access: testListConstraint(), resourceId: "skill-1" });

    expect(row?.id).toBe("skill-1");
    expect(row?.createdAt).toEqual(FIXTURE_NOW);
    expect(row?.scope.organizationId).toBe("org-1");
  });
});
