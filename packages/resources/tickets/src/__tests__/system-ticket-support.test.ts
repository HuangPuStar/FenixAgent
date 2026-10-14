import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  initializeTestApplicationInfrastructure,
  resetAllStubs,
  stubIdentityDirectory,
} from "@fenix/platform-sdk/testing";
import { resetTicketsServerModule } from "../server/runtime";
import { SYSTEM_KEY, seedTwoOrganizations, stubSystemIdentity, systemRequest } from "./system-ticket-fixtures";
import {
  BINDING_B,
  createTicketHarness,
  DATABASE_STUB,
  fixtureBody,
  gitIssue,
  installSystemTicketRoutes,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  type TicketHarness,
} from "./ticket-harness";

/**
 * `/api/system/tickets/:projectId/{labels,members}` 与 `/api/system/tickets/operations/:operationId` 的协议层
 * 用例（**平台管理面的只读支撑面**）。
 *
 * 这三条不在 `/web/tickets/:projectId/:number/**` 之下，但它们是管理台做「改标签、改负责人、处置待确认的写」
 * 的必需数据源：标签编辑器要目录、负责人下拉要成员名录、202 之后要账本。各自对应 `/web` 面的
 * `GET /web/ticket-projects/:projectId/{labels,members}` 与 `GET /web/ticket-operations/:operationId`
 * （路径差异与原因见 `docs/arch/29-tickets.md` §12.1）。
 *
 * 断言分三类：凭据缺失时 401 且零查询；项目坐标不存在时 404 而不是空结果；跨组织坐标只命中被指向的项目。
 * 写路径与详情在 `system-ticket-detail.test.ts`，评论与附件各自成文件。
 */

const ISSUE_NUMBER = "7";

let harness: TicketHarness;

beforeEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
  harness = createTicketHarness();
  stubSystemIdentity();
  seedTwoOrganizations(harness);
});

afterEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
});

describe("管理面目录与账本 — 凭据即判据", () => {
  // 业务意图：这三条都是跨租户读取（成员名录与账本尤其敏感），无 key 时必须零读取零查询。
  test("无 key 时全部端点 401，且零查询", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);
    const requests = [
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/labels`),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/members`),
      new Request("http://localhost/api/system/tickets/operations/11111111-1111-4111-8111-111111111111"),
    ];

    for (const request of requests) {
      const response = await app.handle(request);
      expect(response.status).toBe(401);
    }
    expect(harness.git.calls).toEqual([]);
    expect(harness.projectStore.accesses).toEqual([]);
  });
});

describe("管理面 — 标签目录", () => {
  /** 标签目录替身：ID → 名称的映射是挂载路径唯一的输入。 */
  function stubLabelCatalog(): void {
    harness.git.behaviour.listLabels = async () => [
      { id: "1", name: "bug", color: "ff0000", description: "缺陷" },
      { id: "2", name: "ui", color: "00ff00", description: null },
    ];
  }

  // 业务意图：标签目录是标签编辑器的数据源，管理面必须能读到被指向仓库的目录（不翻页、含描述）。
  test("成功：返回被指向仓库的标签", async () => {
    stubLabelCatalog();
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_B}/labels`));
    const body = (await response.json()) as { data: { items: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.data.items).toEqual([
      { id: "1", name: "bug", color: "ff0000", description: "缺陷" },
      { id: "2", name: "ui", color: "00ff00", description: null },
    ]);
    expect(harness.git.ops("createScopedClient").map((call) => call.bindingId)).toEqual([BINDING_B]);
  });

  // 业务意图：目录读取的项目坐标必须真实存在——拼错的 projectId 给 404 而不是空目录（空目录会被当成「这个仓库没有标签」）。
  test("项目不存在：404 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest("/api/system/tickets/99999999-9999-4999-8999-999999999999/labels"));

    expect(response.status).toBe(404);
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：路径参数形状非法（非 uuid）在边界 400，不做任何项目解析。
  test("projectId 非 uuid：400 且零项目解析", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest("/api/system/tickets/not-a-uuid/labels"));

    expect(response.status).toBe(400);
    expect(harness.projectStore.accesses).toEqual([]);
  });
});

describe("管理面 — 可指派成员", () => {
  /** 成员名录替身：记录被查询的组织，返回一条最小投影。 */
  function stubMembers(organizationIds: string[]): void {
    stubIdentityDirectory({
      listOrganizationMembers: async (input) => {
        organizationIds.push(input.organizationId);
        return { items: [{ userId: "user_member", name: "张三" }], total: 1 };
      },
    });
  }

  // 业务意图：负责人下拉的数据源按**项目所属组织**查，且只回 userId/name——跨组织视图不得成为 PII 出口。
  test("成功：按项目所属组织分页查询且只回 userId/name", async () => {
    const organizationIds: string[] = [];
    stubMembers(organizationIds);
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_B}/members?q=张`));
    const body = (await response.json()) as { data: { items: unknown[]; total: number } };

    expect(response.status).toBe(200);
    expect(organizationIds).toEqual([ORG_B]);
    expect(body.data).toEqual({ items: [{ userId: "user_member", name: "张三" }], total: 1 });
  });

  // 业务意图：分页参数越界由共享 schema 挡住（pageSize 上限 100），不把全量导出当成一次列表请求。
  test("pageSize 越界：400 且零查询", async () => {
    const organizationIds: string[] = [];
    stubMembers(organizationIds);
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/members?pageSize=1000`));

    expect(response.status).toBe(400);
    expect(organizationIds).toEqual([]);
  });

  // 业务意图：成员列表同样以项目坐标为前置——项目不存在时给 404，而不是「这个组织的成员列表为空」。
  test("项目不存在：404 且零身份目录查询", async () => {
    const organizationIds: string[] = [];
    stubMembers(organizationIds);
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      systemRequest("/api/system/tickets/99999999-9999-4999-8999-999999999999/members"),
    );

    expect(response.status).toBe(404);
    expect(organizationIds).toEqual([]);
  });
});

describe("管理面 — 操作账本", () => {
  // 业务意图：管理台要复核的是「这次写到底成没成」，而账本行可能由组织成员在控制台发起——因此本面按 ID 直读，
  // 不要求是操作发起人本人（与 /web 面的可见性差异是刻意的）。
  test("成功：按 ID 直读他人发起的账本行", async () => {
    const seeded = harness.operationStore.seed({ status: "succeeded", actorId: "user_creator", projectId: PROJECT_A });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/operations/${seeded.id}`));
    const body = (await response.json()) as {
      data: { operation: { operationId: string; kind: string; status: string; projectId: string } };
    };

    expect(response.status).toBe(200);
    expect(body.data.operation.operationId).toBe(seeded.id);
    expect(body.data.operation.kind).toBe("issue.update");
    expect(body.data.operation.status).toBe("succeeded");
    expect(body.data.operation.projectId).toBe(PROJECT_A);
  });

  // 业务意图：operationId 形状非法（非 uuid）在边界 400，不进入账本查询。
  test("operationId 非 uuid：400", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest("/api/system/tickets/operations/not-a-uuid"));

    expect(response.status).toBe(400);
  });

  // 业务意图：不存在的 operationId 给 404，不泄露「这条操作属于谁」。
  test("账本行不存在：404", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      systemRequest("/api/system/tickets/operations/11111111-1111-4111-8111-111111111111"),
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
  });

  // 业务意图：未定状态的账本行返回前要回源核对一次（与 web 面同一入口语义）——核对判不出结论时保持未定，但确有一次远端读取。
  test("未定状态：返回前回源核对一次且保持未定", async () => {
    harness.git.behaviour.getIssue = async () =>
      gitIssue({
        number: ISSUE_NUMBER,
        title: "别人改的标题",
        body: fixtureBody({
          messageId: "msg_other",
          authorId: "user_member",
          authorName: "张三",
          body: "别人改的正文",
        }),
      });
    const seeded = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.update",
      projectId: PROJECT_A,
      targetId: ISSUE_NUMBER,
      // 账本行必须落在核对窗口内（超过 15 分钟会判 `needs_review`，那是另一条规则，见 §8.3）。
      createdAt: new Date(),
      updatedAt: new Date(),
      intent: {
        title: "改过的标题",
        body: "改过的正文",
        expectedVersion: "a".repeat(64),
        since: new Date(0).toISOString(),
      },
    });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/operations/${seeded.id}`));
    const payload = (await response.json()) as { data: { operation: { status: string } } };

    expect(response.status).toBe(200);
    // 与目标内容、与 expectedVersion 都不符：按 §8.3 保持未定，不猜结论。
    expect(payload.data.operation.status).toBe("uncertain");
    // 核对确实发生（回源读取），说明管理面复用的是同一个复核入口而不是「只读账本」。
    expect(harness.git.ops("issues.get").length).toBe(1);
    expect(harness.git.writeCalls()).toEqual([]);
  });
});
