/**
 * 知识库展示投影的 owner 侧契约（§1.7 B9）。
 *
 * `findKnowledgeBaseSummariesByIds` 是出口 `@fenix/resource-knowledge/server/summaries` 的**唯一内容**，
 * 消费方是 `@fenix/resource-agent-config` 的 `agent-related-resources.ts`：它把绑定表里的知识库 ID
 * 渲染成前端标签，B9 之前直读宿主 `@server/db/schema`，现在只经这条出口。正因为它跨包，这里钉住的三件事
 * 都是**公开契约**而非实现细节：查哪些列（多一列就是白白穿过包边界的内部结构）、按什么条件查（组织条件
 * 是归属判断，缺了会跨组织取到别家的名称）、以及空 `ids` 必须短路（调用方在「该 Agent 没有知识库绑定」时
 * 会传空数组，此时不该产生任何查询）。
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { stubDb } from "@fenix/platform-sdk/testing";
import { knowledgeBase } from "@fenix/resource-knowledge/db";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { findKnowledgeBaseSummariesByIds } from "../server/repositories/knowledge-base";
import { initializeKnowledgeModuleConfig } from "../server/testing";

const dialect = new PgDialect();

/**
 * 以真实查询构造器形状替换 DB 句柄，记录一次 SELECT 的投影与条件。
 *
 * 断言 SQL 而不是断言断言调用顺序：`where` 收下的是 `and(eq(organizationId), inArray(id))` 这一棵
 * 表达式树，只有经方言编译出 `sql` + `params` 才能确定「按哪个值、哪两列查」。
 */
function captureSelect(rows: unknown[]): { projections: Record<string, unknown>[]; conditions: SQL[] } {
  const captured = { projections: [] as Record<string, unknown>[], conditions: [] as SQL[] };
  stubDb({
    select: (projection: Record<string, unknown>) => ({
      from: () => ({
        where: async (condition: SQL) => {
          captured.projections.push(projection);
          captured.conditions.push(condition);
          return rows;
        },
      }),
    }),
  });
  return captured;
}

describe("知识库展示投影（跨包只读出口）", () => {
  beforeEach(() => {
    initializeKnowledgeModuleConfig();
  });

  // 空 ID 集合必须短路：调用方（无知识库绑定的 Agent）传空数组时不得发起任何查询。
  test("空 id 集合直接返回空 Map 且不查库", async () => {
    stubDb({
      select: () => {
        throw new Error("空集合不应访问数据库");
      },
    });

    await expect(findKnowledgeBaseSummariesByIds({ organizationId: "org-1", knowledgeBaseIds: [] })).resolves.toEqual(
      new Map(),
    );
  });

  // 投影只取展示需要的三列，并同时按组织与 id 集合过滤——组织条件是归属判断，不能省。
  test("按组织与 id 集合查 id/name/slug 三列", async () => {
    const captured = captureSelect([]);

    await findKnowledgeBaseSummariesByIds({ organizationId: "org-1", knowledgeBaseIds: ["kb-1", "kb-2"] });

    expect(captured.projections).toEqual([
      { id: knowledgeBase.id, name: knowledgeBase.name, slug: knowledgeBase.slug },
    ]);
    const { sql, params } = dialect.sqlToQuery(captured.conditions[0]);
    expect(sql).toContain('"organization_id" =');
    expect(sql).toContain('"id" in');
    expect(params).toEqual(["org-1", "kb-1", "kb-2"]);
  });

  // 结果以 id 为键、只带展示字段：消费方按 id 取用，未命中的 id 由它退化成 ID 标签。
  test("结果以 id 为键返回 name 与 slug", async () => {
    captureSelect([{ id: "kb-1", name: "知识库", slug: "docs" }]);

    const summaries = await findKnowledgeBaseSummariesByIds({
      organizationId: "org-1",
      knowledgeBaseIds: ["kb-1", "kb-2"],
    });

    expect(summaries.size).toBe(1);
    expect(summaries.get("kb-1")).toEqual({ name: "知识库", slug: "docs" });
    expect(summaries.has("kb-2")).toBe(false);
  });
});
