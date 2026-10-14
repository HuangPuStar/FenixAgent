import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubIdentityDirectory } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import { createApiSystemTicketsRoutes } from "../server/routes/api/system-tickets";
import { resetTicketsServerModule } from "../server/runtime";
import {
  createStubSystemApiGuardPlugin,
  createTicketHarness,
  installTicketModule,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  stubDirectory,
  type TicketHarness,
} from "./ticket-harness";

/**
 * `/api/system/tickets` 协议层用例（**平台管理面**）。
 *
 * 这个面回答的问题与 `/web/tickets/:projectId` 不同：**跨组织**列出全部组织的工单，判据是系统 API Key 而不是
 * 某个主体在某个组织里的角色。因此本文件覆盖三类东西：
 *
 * 1. **凭据即判据**：无 key、错误 key 都在 handler 之前 401（`{ error: { code: "UNAUTHORIZED" } }`），
 *    正确 key 才落到读取路径——`systemApiKeyAuth: true` 写在路由声明里，这条声明只有真的被守卫执行才算数。
 * 2. **跨组织读取**：两个组织的项目各自有工单时，一页里能同时看到它们，并带出归属坐标（组织名 + 仓库坐标）；
 *    组织 / 项目筛选命中同一份谓词。
 * 3. **信封**：`/api/system/*` 是 `{ success: true, data: { items, total, page, pageSize } }`，不是 `/web` 的
 *    `{ success: false, error }`——照 `/web` 断言会漏掉真实的协议差异。失败面只有 401 与 500（守卫 + 存储/装配
 *    故障），因此这里不造 400/404 用例：那些状态码在这个面上不存在。
 *
 * 守卫是包内替身（资源包不得依赖 `apps/server`）：它复刻守卫的**可观察契约**并真的比对 key，因此上面第 1 类
 * 断言不是永真；宿主 `RCS_SYSTEM_API_KEYS` 的读取与「未配置即全拒」策略仍归宿主用例与部署校验。
 *
 * 授权在 `/web` 面（受控查询）与共享的领域服务不在这里重复：本文件只证明「系统路径能跨组织读到同一份索引」。
 */

const SYSTEM_KEY = "sys-key-tickets-1";

/** 系统 key 守卫替身 + 真实 Facade（harness 的领域服务与索引替身）。 */
function buildApp(harness: TicketHarness) {
  installTicketModule(harness);
  return new Elysia().use(
    createApiSystemTicketsRoutes({ systemApiGuardPlugin: createStubSystemApiGuardPlugin(SYSTEM_KEY) }),
  );
}

function authorizedRequest(path: string) {
  return new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${SYSTEM_KEY}` } });
}

/** 两个组织的项目：坐标（仓库 owner/name）不同，才能看出列表带的是归属而不是当前组织。 */
function seedTwoOrganizations(harness: TicketHarness): void {
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, owner: "aos-bot", name: "alpha-repo" });
  harness.projectStore.seed({ id: PROJECT_B, organizationId: ORG_B, owner: "aos-bot", name: "beta-repo" });
  harness.indexStore.seed({
    projectId: PROJECT_A,
    issueNumber: "7",
    title: "甲组织的工单",
    authorId: "user_member",
    authorName: "张三",
  });
  harness.indexStore.seed({
    projectId: PROJECT_B,
    issueNumber: "3",
    title: "乙组织的工单",
    authorId: "user_other",
    syncedAt: new Date("2026-10-12T09:00:00.000Z"),
  });
  stubDirectory({ users: [{ id: "user_member", name: "张三" }] });
  stubIdentityDirectory({
    listOrganizationNames: async (organizationIds) =>
      new Map(organizationIds.map((id) => [id, id === ORG_A ? "阿尔法组织" : "贝塔组织"])),
  });
}

let harness: TicketHarness;

beforeEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
  harness = createTicketHarness();
});

describe("系统工单管理面路由", () => {
  // 业务意图：这十三条路由是前端契约（docs/arch/29-tickets.md §12.1 的路径表），清单本身要被钉住——
  // 少一条等于管理台某个动作 404，多一条或改名会让已对齐的前端静默调错端点。
  test("路由清单与 §12.1 的路径表逐条一致", () => {
    const app = createApiSystemTicketsRoutes({ systemApiGuardPlugin: createStubSystemApiGuardPlugin(SYSTEM_KEY) });

    expect(app.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /api/system/tickets/",
      "GET /api/system/tickets/:projectId/:number",
      "PATCH /api/system/tickets/:projectId/:number",
      "PUT /api/system/tickets/:projectId/:number/labels",
      "GET /api/system/tickets/:projectId/:number/comments",
      "POST /api/system/tickets/:projectId/:number/comments",
      "PATCH /api/system/tickets/:projectId/:number/comments/:commentId",
      "GET /api/system/tickets/:projectId/:number/attachments",
      "POST /api/system/tickets/:projectId/:number/attachments",
      "GET /api/system/tickets/:projectId/:number/attachments/:attachmentId",
      "GET /api/system/tickets/:projectId/labels",
      "GET /api/system/tickets/:projectId/members",
      "GET /api/system/tickets/operations/:operationId",
    ]);
  });

  // 业务意图：系统面是跨租户读取，凭据缺失时必须 fail-closed——一个放行的空 key 就等于把全部组织的工单开放给匿名调用方。
  test("缺少系统 key 时 401，且不进入读取路径", async () => {
    seedTwoOrganizations(harness);
    const app = buildApp(harness);

    const response = await app.handle(new Request("http://localhost/api/system/tickets"));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "UNAUTHORIZED", message: "Invalid system API key" } });
    // 守卫在 handler 之前拒绝：一次跨组织读取都没有发生（读取入参被仓储替身记录在案）。
    expect(harness.indexStore.platformQueries).toEqual([]);
  });

  // 业务意图：错误 key 与缺失 key 同形拒绝（不给「key 是否正确」留探测面），同样不产生读取。
  test("错误系统 key 时 401", async () => {
    seedTwoOrganizations(harness);
    const app = buildApp(harness);

    const response = await app.handle(
      new Request("http://localhost/api/system/tickets", { headers: { Authorization: "Bearer wrong-key" } }),
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAUTHORIZED");
  });

  // 业务意图：平台管理员的核心诉求——一页里同时看到多个组织的工单，且每行都带得出「这是哪个组织、哪个仓库」。
  test("携带系统 key 时跨组织列出全部工单并带归属坐标", async () => {
    seedTwoOrganizations(harness);
    const app = buildApp(harness);

    const response = await app.handle(authorizedRequest("/api/system/tickets"));
    const body = (await response.json()) as {
      success: boolean;
      data: {
        items: Array<{
          issueNumber: string;
          title: string;
          organizationId: string;
          organizationName: string;
          projectId: string;
          projectName: string;
          projectOwner: string;
        }>;
        total: number;
        page: number;
        pageSize: number;
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(2);
    expect(body.data.page).toBe(1);
    // 排序是「最后同步时间降序 + 主键兜底」（仓储口径）：乙组织的工单后同步，因此排在前。
    expect(body.data.items.map((item) => item.issueNumber)).toEqual(["3", "7"]);
    expect(body.data.items.map((item) => item.organizationId)).toEqual([ORG_B, ORG_A]);
    expect(body.data.items.map((item) => item.organizationName)).toEqual(["贝塔组织", "阿尔法组织"]);
    expect(body.data.items.map((item) => item.projectName)).toEqual(["beta-repo", "alpha-repo"]);
    expect(body.data.items.map((item) => item.projectOwner)).toEqual(["aos-bot", "aos-bot"]);
    expect(body.data.items.map((item) => item.title)).toEqual(["乙组织的工单", "甲组织的工单"]);
  });

  // 业务意图：筛选是收窄而不是范围强制（凭据已允许看全部），因此按组织筛选必须只留下该组织的行，且不改变总数口径。
  test("按组织筛选只返回该组织的工单", async () => {
    seedTwoOrganizations(harness);
    const app = buildApp(harness);

    const response = await app.handle(authorizedRequest(`/api/system/tickets?organizationId=${ORG_A}`));
    const body = (await response.json()) as {
      data: { items: Array<{ issueNumber: string; organizationId: string }>; total: number };
    };

    expect(response.status).toBe(200);
    expect(body.data.total).toBe(1);
    expect(body.data.items.map((item) => item.issueNumber)).toEqual(["7"]);
    expect(body.data.items[0]?.organizationId).toBe(ORG_A);
  });

  // 业务意图：分页是跨组织的统一分页（页码 → 偏移），第二页不能重复第一页的行，否则管理员会把同一条工单看两遍。
  test("分页按页码切分且 total 跨页保持", async () => {
    seedTwoOrganizations(harness);
    const app = buildApp(harness);

    const firstPage = await app.handle(authorizedRequest("/api/system/tickets?page=1&pageSize=1"));
    const secondPage = await app.handle(authorizedRequest("/api/system/tickets?page=2&pageSize=1"));
    const first = (await firstPage.json()) as { data: { items: Array<{ issueNumber: string }>; total: number } };
    const second = (await secondPage.json()) as { data: { items: Array<{ issueNumber: string }>; total: number } };

    expect(first.data.items.map((item) => item.issueNumber)).toEqual(["3"]);
    expect(second.data.items.map((item) => item.issueNumber)).toEqual(["7"]);
    expect([first.data.total, second.data.total]).toEqual([2, 2]);
  });
});
