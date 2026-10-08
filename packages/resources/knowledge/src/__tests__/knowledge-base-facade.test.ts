// Knowledge 门面的可见范围断言：两条协议面各自的可见集合必须是**门面上的命名语义**，而且组织范围
// 只能来自 actor。
//
// 与 `./api-knowledge-bases-routes.test.ts`、`./round39-knowledge-routes.test.ts` 的分工：那两条用例
// 证明协议形状（分页信封、鉴权、路由错误映射），本文件证明**交给仓储的可见条件确实来自 actor 与所选的
// 范围**——替身记录每次查询收到的 `(organizationId, includeGlobal, limit/offset)`，因此把范围写反或
// 让组织随调用方变化，都会在这里变红。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { knowledgeBaseFacade } from "../server/facades/knowledge-base-facade";
import type { KnowledgeBaseRow } from "../server/repositories/knowledge-base";
import {
  type KnowledgeBaseVisibilityPageQuery,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../server/repositories/knowledge-base";
import { setKnowledgeProviderForTesting } from "../server/services/knowledge-provider/registry";
import { initializeKnowledgeModuleConfig } from "../server/testing";

const ACTOR = { organizationId: "org-1", userId: "user-1" } as const;

function knowledgeBaseRow(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "Product Docs",
    slug: "product-docs",
    description: null,
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: "org-1",
    remoteUserId: "user-1",
    metadata: { parseMethod: "builtin", chunkMethod: "naive" },
    status: "ready",
    lastError: null,
    createdAt: new Date(1718000000 * 1000),
    updatedAt: new Date(1718000100 * 1000),
    ...overrides,
  };
}

/**
 * 可见集替换身：按收到的可见条件模拟 SQL——`includeGlobal=false` 只返回本组织行，
 * 为真时并入全局行（`organizationId` 为其它组织的"跨组织共享"行）。同时记录收到的查询供断言。
 */
function installVisibleRepoStub(): {
  pageQueries: KnowledgeBaseVisibilityPageQuery[];
  countQueries: Array<{ organizationId: string; includeGlobal: boolean }>;
} {
  const pageQueries: KnowledgeBaseVisibilityPageQuery[] = [];
  const countQueries: Array<{ organizationId: string; includeGlobal: boolean }> = [];
  const rows = [knowledgeBaseRow(), knowledgeBaseRow({ id: "kb-global", organizationId: "org-2" })];
  knowledgeBaseRepo.listVisible = mock(async (input) => {
    pageQueries.push(input);
    return rows.filter((row) => row.organizationId === input.organizationId || input.includeGlobal);
  });
  knowledgeBaseRepo.countVisible = mock(async (input) => {
    countQueries.push(input);
    return rows.filter((row) => row.organizationId === input.organizationId || input.includeGlobal).length;
  });
  return { pageQueries, countQueries };
}

const originals = {
  listVisible: knowledgeBaseRepo.listVisible,
  countVisible: knowledgeBaseRepo.countVisible,
  countBindings: knowledgeBaseRepo.countBindings,
  countResources: knowledgeResourceRepo.countByKnowledgeBase,
};

describe("Knowledge 门面的可见范围", () => {
  beforeEach(() => {
    initializeKnowledgeModuleConfig();
    // 没有配置远端 provider：控制台列表的远端回填短路成「无操作」，可见范围才是本文件的断言对象。
    setKnowledgeProviderForTesting(null);
    knowledgeBaseRepo.countBindings = mock(async () => 0);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 0);
  });

  afterEach(() => {
    knowledgeBaseRepo.listVisible = originals.listVisible;
    knowledgeBaseRepo.countVisible = originals.countVisible;
    knowledgeBaseRepo.countBindings = originals.countBindings;
    knowledgeResourceRepo.countByKnowledgeBase = originals.countResources;
    setKnowledgeProviderForTesting(null);
  });

  // 控制台列表：范围是「仅本组织」，且不分页；跨组织共享的全局库不得出现在控制台（历史口径）。
  test("listForConsole 用 actor 的组织按本组织范围读取", async () => {
    const { pageQueries } = installVisibleRepoStub();

    const items = await knowledgeBaseFacade.listForConsole(ACTOR);

    expect(pageQueries).toEqual([{ organizationId: "org-1", includeGlobal: false }]);
    expect(items.map((item) => item.id)).toEqual(["kb-1"]);
  });

  // 换一个组织必须换一批可见行：范围随 actor 变化，说明组织谓词没有被硬编码。
  test("listForConsole 对另一个组织只返回该组织的知识库", async () => {
    const { pageQueries } = installVisibleRepoStub();

    const items = await knowledgeBaseFacade.listForConsole({ organizationId: "org-2", userId: "user-2" });

    expect(pageQueries).toEqual([{ organizationId: "org-2", includeGlobal: false }]);
    expect(items.map((item) => item.id)).toEqual(["kb-global"]);
  });

  // 对外列表：范围是「本组织 ∪ 跨组织共享的全局库」，分页与计数共用同一可见条件。
  test("listForExternal 并入全局库并下推分页", async () => {
    const { pageQueries, countQueries } = installVisibleRepoStub();

    const page = await knowledgeBaseFacade.listForExternal(ACTOR, 2, 3);

    expect(pageQueries).toEqual([{ organizationId: "org-1", includeGlobal: true, limit: 3, offset: 3 }]);
    expect(countQueries).toEqual([{ organizationId: "org-1", includeGlobal: true }]);
    expect(page).toMatchObject({ total: 2, page: 2, pageSize: 3 });
    expect(page.items.map((item) => item.id)).toEqual(["kb-1", "kb-global"]);
  });

  // 两条协议面的范围必须不同：控制台不得看到全局库，对外列表必须看到——把任一侧写反都会在这里失败。
  test("两条协议面的可见范围互不串用", async () => {
    const { pageQueries } = installVisibleRepoStub();

    await knowledgeBaseFacade.listForConsole(ACTOR);
    await knowledgeBaseFacade.listForExternal(ACTOR, 1, 20);

    expect(pageQueries).toEqual([
      { organizationId: "org-1", includeGlobal: false },
      { organizationId: "org-1", includeGlobal: true, limit: 20, offset: 0 },
    ]);
  });
});
