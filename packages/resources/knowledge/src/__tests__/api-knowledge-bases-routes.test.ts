import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readJson } from "@fenix/platform-sdk/testing";
import {
  type KnowledgeBaseRow,
  type KnowledgeBaseVisibilityPageQuery,
  knowledgeBaseRepo,
  knowledgeResourceRepo,
} from "../server/repositories/knowledge-base";
import { createApiKnowledgeBaseRoutes } from "../server/routes/api/knowledge-bases";
import { initializeKnowledgeModuleConfig } from "../server/testing";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

/**
 * 认证上下文由守卫替身写入（真实守卫属宿主，包内不得依赖它构造路由）。
 * 取值与迁移前 `setTestAuth()` / `setTestOrgContext()` 注入的一致：`{ organizationId: "org-1", userId: "user-1" }`。
 */
const AUTH_CONTEXT = { organizationId: "org-1", userId: "user-1" } as const;
const apiKnowledgeBasesRoute = createApiKnowledgeBaseRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(AUTH_CONTEXT),
});
/** 拒绝态守卫（`authContext = null` 返回 401）：用于断言端点确实声明了 `sessionAuth`。 */
const deniedApiKnowledgeBasesRoute = createApiKnowledgeBaseRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(null),
});

function request(path: string, init?: RequestInit) {
  return apiKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

function deniedRequest(path: string, init?: RequestInit) {
  return deniedApiKnowledgeBasesRoute.handle(new Request(`http://localhost${path}`, init));
}

/** 列表行的固定时间戳：`sanitizeKnowledgeBase` 会把 Date 折算成秒级 Unix 时间。 */
const CREATED_AT_SECONDS = 1718000000;
const UPDATED_AT_SECONDS = 1718000100;

function knowledgeBaseRow(overrides: Partial<KnowledgeBaseRow> = {}): KnowledgeBaseRow {
  return {
    id: "kb-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "Product Docs",
    slug: "product-docs",
    description: "knowledge for product docs",
    provider: "ragflow",
    remoteId: "remote-kb-1",
    remoteAccountId: "org-1",
    remoteUserId: "user-1",
    // 配置类字段存在 metadata 里（见 `knowledge-metadata`），回显时拉平成 DTO 字段。
    metadata: { parseMethod: "builtin", chunkMethod: "naive" },
    status: "ready",
    lastError: null,
    createdAt: new Date(CREATED_AT_SECONDS * 1000),
    updatedAt: new Date(UPDATED_AT_SECONDS * 1000),
    ...overrides,
  };
}

const originals = {
  listVisible: knowledgeBaseRepo.listVisible,
  countVisible: knowledgeBaseRepo.countVisible,
  countBindings: knowledgeBaseRepo.countBindings,
  countByKnowledgeBase: knowledgeResourceRepo.countByKnowledgeBase,
};

/** 分页信封的运行时读数：只取用例断言用得到的字段，避免把协议类型当成测试事实。 */
interface ListPage {
  items: Array<{ id: string }>;
  total: number;
  page: number;
  pageSize: number;
}

async function readListPage(response: Response): Promise<ListPage> {
  return (await readJson(response)) as ListPage;
}

/**
 * 「知识库表」：本组织两行（`kb-org-new` / `kb-org-old`，时间戳不同以固定排序）+ 其它组织一行。
 *
 * 本组织的两行同时属于「本组织可见」与「全表」两个来源——旧实现把两个来源的数组直接拼接，因此它们
 * 会在对外列表里各出现两次，`total` 也会是 |本组织| + |全表| = 2 + 3。用来区分的数字（3 与 5）刻意
 * 不同，断言才能同时识别「重复项」与「重复计数」。
 */
const VISIBLE_TABLE: KnowledgeBaseRow[] = [
  knowledgeBaseRow({ id: "kb-org-new", updatedAt: new Date(1718000300 * 1000) }),
  knowledgeBaseRow({ id: "kb-org-old", updatedAt: new Date(1718000100 * 1000) }),
  knowledgeBaseRow({
    id: "kb-other-org",
    organizationId: "org-2",
    userId: "user-2",
    updatedAt: new Date(1718000200 * 1000),
  }),
];

/**
 * 可见集合的替身：**按表语义**给数——`includeGlobal` 为真时返回全表，否则只返回本组织行；再按仓储的
 * 排序口径（本组织行优先，其余按更新时间倒序）排序、按 limit/offset 截取。
 *
 * 为什么替身要复刻过滤与分页，而不是像别处那样直接给定返回值：本组用例断言的是「同一个知识库不会
 * 因为既属于本组织、又落在全表里而在响应里出现两次」。若替身按「本组织来源」「全局来源」分别给结果，
 * 重复就成了替身自己制造的，断言不再描述被测行为。真实 SQL 的谓词内容（哪一列、绑了哪个值）由
 * `round46-knowledge-base-repository.test.ts` 在真仓储上断言，本文件只证明协议层的合成语义。
 */
function installVisibleTableStub(): void {
  const visibleRows = (input: { organizationId: string; includeGlobal: boolean }): KnowledgeBaseRow[] =>
    VISIBLE_TABLE.filter((row) => input.includeGlobal || row.organizationId === input.organizationId).sort((a, b) => {
      const own = (row: KnowledgeBaseRow) => (row.organizationId === input.organizationId ? 0 : 1);
      return own(a) - own(b) || b.updatedAt.getTime() - a.updatedAt.getTime();
    });

  knowledgeBaseRepo.listVisible = mock(async (input: KnowledgeBaseVisibilityPageQuery) => {
    const rows = visibleRows(input);
    if (input.limit === undefined) return rows;
    return rows.slice(input.offset ?? 0, (input.offset ?? 0) + input.limit);
  });
  knowledgeBaseRepo.countVisible = mock(async (input) => visibleRows(input).length);
  knowledgeBaseRepo.countBindings = mock(async () => 0);
  knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 0);
}

describe("API Knowledge Base Routes", () => {
  beforeEach(() => {
    // repository 是包内唯一数据访问点，所以这里替身替换 repository 而不是 stub 掉 service：
    // 覆盖范围因此包含 `sanitizeKnowledgeBase` 的真实映射（DTO 字段名、时间戳折算、counts 注入）。
    knowledgeBaseRepo.listVisible = mock(async () => [knowledgeBaseRow()]);
    knowledgeBaseRepo.countVisible = mock(async () => 1);
    knowledgeBaseRepo.countBindings = mock(async () => 2);
    knowledgeResourceRepo.countByKnowledgeBase = mock(async () => 5);
    initializeKnowledgeModuleConfig();
  });

  afterEach(() => {
    knowledgeBaseRepo.listVisible = originals.listVisible;
    knowledgeBaseRepo.countVisible = originals.countVisible;
    knowledgeBaseRepo.countBindings = originals.countBindings;
    knowledgeResourceRepo.countByKnowledgeBase = originals.countByKnowledgeBase;
  });

  // 外部知识库列表接口应返回稳定分页结构，而不是直接返回裸数组。
  test("GET /api/knowledge-bases returns paginated knowledge base list", async () => {
    const res = await request("/api/knowledge-bases?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json).toEqual({
      items: [
        {
          id: "kb-1",
          name: "Product Docs",
          slug: "product-docs",
          description: "knowledge for product docs",
          provider: "ragflow",
          remoteId: "remote-kb-1",
          remoteAccountId: "org-1",
          remoteUserId: "user-1",
          status: "ready",
          lastError: null,
          bindingsCount: 2,
          resourcesCount: 5,
          recentResources: [],
          createdAt: CREATED_AT_SECONDS,
          updatedAt: UPDATED_AT_SECONDS,
          userId: "user-1",
          organizationId: "org-1",
          embeddingModel: null,
          parseMethod: "builtin",
          chunkMethod: "naive",
          remoteExists: true,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 10,
    });
  });

  // 分页与计数必须下推到查询层：协议层只把 page/pageSize 换算成 limit/offset，不再合并数组后切片。
  test("GET /api/knowledge-bases 把分页与可见范围下推给查询层", async () => {
    const pageQueries: Array<{ organizationId: string; includeGlobal: boolean; limit?: number; offset?: number }> = [];
    const countQueries: Array<{ organizationId: string; includeGlobal: boolean }> = [];
    knowledgeBaseRepo.listVisible = mock(async (input) => {
      pageQueries.push(input);
      return [knowledgeBaseRow()];
    });
    knowledgeBaseRepo.countVisible = mock(async (input) => {
      countQueries.push(input);
      return 7;
    });

    const body = await readJson(await request("/api/knowledge-bases?page=2&pageSize=3"));

    expect(pageQueries).toEqual([{ organizationId: "org-1", includeGlobal: true, limit: 3, offset: 3 }]);
    // 计数与列表共用同一份可见条件，否则 total 描述的不是分页所作用的那个集合。
    expect(countQueries).toEqual([{ organizationId: "org-1", includeGlobal: true }]);
    expect(body).toMatchObject({ total: 7, page: 2, pageSize: 3 });
  });

  // 对外接口同样必须挂上会话守卫：缺少认证上下文时不得返回成功 DTO。
  test("GET /api/knowledge-bases 缺少认证上下文返回 401", async () => {
    const res = await deniedRequest("/api/knowledge-bases?page=1&pageSize=10");
    expect(res.status).toBe(401);
  });

  // 对外列表是**一份**可见集合：本组织的知识库不得因为同时落在「本组织」与「全表」里而在 items 中出现两次。
  // 这是迁移前后的合同差异（旧实现把两个来源的数组拼接），也是本文件存在的理由——断言挂在返回的多重集上，
  // 任何重新引入「按来源拼接」的写法都会让 items 变成 5 条并在这里失败。
  test("GET /api/knowledge-bases 同一知识库在列表里只出现一次", async () => {
    installVisibleTableStub();

    const { items } = await readListPage(await request("/api/knowledge-bases?page=1&pageSize=10"));

    // 本组织行优先、其余按更新时间倒序；本组织的两行各出现一次，其它组织的行按「全局」语义并入。
    expect(items.map((item) => item.id)).toEqual(["kb-org-new", "kb-org-old", "kb-other-org"]);
    // 与顺序无关的语义断言：多重集里没有重复项（旧口径下这里会是 5 而元素只有 3 种）。
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
  });

  // total 描述的是分页所作用的那一个集合，不是各来源条数之和：旧口径为 |本组织| + |全表| = 5，去重后为 3。
  // 配合 pageSize=2 使用，让 total（3）与当前页长度（2）不同，避免由「total 恰好等于页长」蒙对。
  test("GET /api/knowledge-bases 的 total 是去重后可见集合的大小", async () => {
    installVisibleTableStub();

    const body = await readListPage(await request("/api/knowledge-bases?page=1&pageSize=2"));

    expect(body.items).toHaveLength(2);
    expect(body.total).toBe(3);
    expect(body.page).toBe(1);
    expect(body.pageSize).toBe(2);
  });

  // 去重后页边界随之前移：第 2 页接着第 1 页继续，两页拼起来正好是可见集合，不重不漏。
  test("GET /api/knowledge-bases 的页边界落在去重后的可见集合上", async () => {
    installVisibleTableStub();

    const first = await readListPage(await request("/api/knowledge-bases?page=1&pageSize=2"));
    const second = await readListPage(await request("/api/knowledge-bases?page=2&pageSize=2"));

    expect(first.items.map((item) => item.id)).toEqual(["kb-org-new", "kb-org-old"]);
    expect(second.items.map((item) => item.id)).toEqual(["kb-other-org"]);
    expect(second.total).toBe(3);
  });
});
