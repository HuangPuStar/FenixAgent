import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitError, type GitIssue } from "@fenix/git/server";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { resetTicketsServerModule } from "../server/runtime";
import { describeIssue } from "../server/services/ticket-issue-write";
import {
  jsonRequest,
  projectRow,
  SYSTEM_KEY,
  SYSTEM_USER,
  seedTwoOrganizations,
  stubSystemIdentity,
  systemRequest,
} from "./system-ticket-fixtures";
import {
  BINDING_A,
  BINDING_B,
  createTicketHarness,
  DATABASE_STUB,
  fixtureBody,
  gitIssue,
  IDEMPOTENCY_KEY,
  installSystemTicketRoutes,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  seedOwnership,
  type TicketHarness,
} from "./ticket-harness";

/**
 * `/api/system/tickets/:projectId/:number/**` 协议层用例（**平台管理面的工单本体**）。
 *
 * 这个面回答的问题与 `/web/tickets/:projectId/:number` 相同（详情、改字段、标签挂载），但判据是系统 API Key
 * 而不是某个主体在某个组织里的角色。因此本文件覆盖四类东西：
 *
 * 1. **成功路径的协议形状**：信封是 `{ success: true, data }`、写路径的 200/202、锁定的稳定错误码；
 * 2. **参数非法**：路径参数（uuid / 正整数串）、查询参数与幂等键各挡在边界上，且**零写入**；
 * 3. **凭据即判据**：无 key 在 handler 之前 401，且不产生任何读取或写入（跨租户面的唯一安全合同）；
 * 4. **跨组织坐标**：两个组织的项目各自有工单时，读写只落在被指向的那一个组织上（远端绑定、账本、索引三处
 *    都可查），另一个组织的数据一行不动——坐标取自项目行，不取自请求。
 *
 * 与 `/web` 面的差异只覆盖一处：管理面**没有角色判定**（凭据即判据），因此不存在 403 分支；「谁能拿到 key」
 * 是部署与凭据分发问题，不是本文件能证的。
 */

const ISSUE_NUMBER = "7";
const MESSAGE_ID = "msg_i1";
const REMOTE_BODY = "正文";

/** 远端工单的初始形态：正文带可信身份头（作者核验要求头部与归属行同源）。 */
function initialIssue(overrides: Partial<GitIssue> = {}): GitIssue {
  return gitIssue({
    number: ISSUE_NUMBER,
    title: "预览页打不开",
    body: fixtureBody({ messageId: MESSAGE_ID, authorId: "user_member", authorName: "张三", body: REMOTE_BODY }),
    ...overrides,
  });
}

/**
 * Git 替身按 Forgejo 语义回显写入：`issues.get` 返回当前工单，`issues.edit` / `issues.setLabels` 把入参合并进去。
 *
 * 替身若不回显，「回源算出的版本」就成了用例自己编的值，`expectedVersion` 的断言会失去意义。
 */
function stubIssueBackend(harness: TicketHarness, issue: GitIssue): { current: GitIssue } {
  const state = { current: issue };
  harness.git.behaviour.getIssue = async () => state.current;
  harness.git.behaviour.editIssue = async (_issueNumber, input) => {
    state.current = {
      ...state.current,
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.state === undefined ? {} : { state: input.state }),
    };
    return state.current;
  };
  harness.git.behaviour.setLabels = async (_issueNumber, labels) => {
    state.current = {
      ...state.current,
      labels: labels.map((name, index) => ({ id: String(index + 1), name, color: "ff0000", description: null })),
    };
    return state.current;
  };
  return state;
}

/** 当前远端内容对应的期望版本（每次写入后都要重取，不能缓存最初那个）。 */
function versionOf(issue: GitIssue): string {
  return describeIssue(issue).version;
}

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

describe("管理面 — 凭据即判据", () => {
  // 业务意图：管理面全部端点都是跨租户面，凭据缺失时必须在进 handler 之前拒绝——放行一次就等于把全部组织的工单开放给匿名调用方。
  test("无 key 时全部端点 401，且零读取、零写入", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);
    const requests = [
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
        body: JSON.stringify({ title: "改标题", expectedVersion: "a".repeat(64) }),
      }),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/labels`, {
        method: "PUT",
        headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
        body: JSON.stringify({ labelIds: [], expectedVersion: "a".repeat(64) }),
      }),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/labels`),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/members`),
      new Request("http://localhost/api/system/tickets/operations/11111111-1111-4111-8111-111111111111"),
    ];

    for (const request of requests) {
      const response = await app.handle(request);
      expect(response.status).toBe(401);
      expect((await response.json()) as unknown).toEqual({
        error: { code: "UNAUTHORIZED", message: "Invalid system API key" },
      });
    }
    expect(harness.git.calls).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
    expect(harness.indexStore.rows.length).toBe(2);
  });
});

describe("管理面 — 详情", () => {
  // 业务意图：详情是管理台打开工单的第一跳，必须与 web 面同形（连同 pendingOperationId 这一维），否则前端要写两套渲染分支。
  test("成功：返回详情视图与在途变更坐标", async () => {
    harness.git.behaviour.getIssue = async () => initialIssue();
    await seedOwnership({
      messages: harness.messageStore.repository,
      objectKind: "issue",
      providerObjectId: ISSUE_NUMBER,
      messageId: MESSAGE_ID,
      authorId: "user_member",
      authorName: "张三",
      body: REMOTE_BODY,
    });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`));
    const body = (await response.json()) as {
      success: boolean;
      data: {
        ticket: {
          issueNumber: string;
          title: string;
          body: string;
          author: { id: string | null; name: string };
          pendingOperationId: string | null;
        };
      };
    };

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.ticket.issueNumber).toBe(ISSUE_NUMBER);
    expect(body.data.ticket.title).toBe("预览页打不开");
    // 正文必须已剥离身份头：协议头不得出现在协议视图里。
    expect(body.data.ticket.body.trimEnd()).toBe(REMOTE_BODY);
    // 作者归属经账本核验，展示名取身份目录当前值。
    expect(body.data.ticket.author).toEqual({ id: "user_member", name: "张三", source: "aos" });
    expect(body.data.ticket.pendingOperationId).toBeNull();
  });

  // 业务意图：跨组织坐标由请求给出，指向乙组织的项目时只能读到乙组织仓库里的工单，绝不能串到甲组织的绑定。
  test("跨组织坐标：读到的是被指向那个组织的仓库", async () => {
    stubIssueBackend(harness, initialIssue({ number: "3", title: "乙组织的工单" }));
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_B}/3`));
    const body = (await response.json()) as { data: { ticket: { title: string } } };

    expect(response.status).toBe(200);
    expect(body.data.ticket.title).toBe("乙组织的工单");
    expect(harness.git.ops("createScopedClient").map((call) => call.bindingId)).toEqual([BINDING_B]);
  });

  // 业务意图：projectId 必须真实存在（它来自平台列表行）；拼错/已删除给稳定 404，且不产生任何上游调用。
  test("项目不存在：404 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      systemRequest(`/api/system/tickets/99999999-9999-4999-8999-999999999999/${ISSUE_NUMBER}`),
    );

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：工单号形状非法在边界上就是 400，不进入上游查询（把「参数写错」与「工单不存在」分开）。
  test("工单号非法：400 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/0`));

    expect(response.status).toBe(400);
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：上游读故障是 503 而不是空正文——静默降级会让管理员以为工单正文真的为空。
  test("上游不可用：503", async () => {
    harness.git.behaviour.getIssue = async () => {
      throw new GitError("UNAVAILABLE", "上游不可达");
    };
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("GIT_UNAVAILABLE");
  });
});

describe("管理面 — 修改工单", () => {
  // 业务意图：改字段的写路径在管理面必须完整可用，且审计主体写真实系统租户（不是匿名写入）、组织取项目行。
  test("成功：200 + 工单视图，账本以系统租户为审计主体", async () => {
    const state = stubIssueBackend(harness, initialIssue());
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`,
        "PATCH",
        { title: "改过的标题", expectedVersion: versionOf(state.current) },
        IDEMPOTENCY_KEY,
      ),
    );
    const body = (await response.json()) as { data: { ticket: { title: string }; operationId: string } };

    expect(response.status).toBe(200);
    expect(body.data.ticket.title).toBe("改过的标题");
    expect(body.data.operationId).toBeString();
    const operation = harness.operationStore.rows[0];
    // 审计主体：账本的发起人是系统托管租户（不是某个组织成员，也不是匿名）。
    expect(operation?.actorId).toBe(SYSTEM_USER);
    expect(operation?.organizationId).toBe(ORG_A);
    expect(operation?.kind).toBe("issue.update");
    // 跨组织坐标：绑定的就是被指向项目的仓库。
    expect(harness.git.ops("createScopedClient").every((call) => call.bindingId === BINDING_A)).toBe(true);
  });

  // 业务意图：状态关闭/重开与负责人都走同一个 PATCH，管理台据此完成「关闭 / 重开 / 换负责人」三件事。
  test("成功：关闭工单与指派负责人", async () => {
    const state = stubIssueBackend(harness, initialIssue());
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`,
        "PATCH",
        { state: "closed", assigneeId: "user_member", expectedVersion: versionOf(state.current) },
        IDEMPOTENCY_KEY,
      ),
    );
    const body = (await response.json()) as { data: { ticket: { state: string; assignee: { id: string } } } };

    expect(response.status).toBe(200);
    expect(body.data.ticket.state).toBe("closed");
    expect(body.data.ticket.assignee.id).toBe("user_member");
  });

  // 业务意图：版本冲突的判定与 web 面同源——409 且不产生账本行，否则用户的幂等键会被一次 409 烧掉。
  test("版本冲突：409 且不产生账本行", async () => {
    stubIssueBackend(harness, initialIssue());
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`,
        "PATCH",
        { title: "改过的标题", expectedVersion: "a".repeat(64) },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT");
    expect(harness.operationStore.rows).toEqual([]);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 业务意图：同一工单上已有未确认变更时必须拒绝后续修改（409 TICKET_OPERATION_PENDING），前端据此引导先复核。
  test("同工单有在途修改：409 TICKET_OPERATION_PENDING 且零上游写入", async () => {
    const state = stubIssueBackend(harness, initialIssue());
    harness.operationStore.seed({
      projectId: PROJECT_A,
      kind: "issue.update",
      status: "dispatching",
      targetId: ISSUE_NUMBER,
    });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`,
        "PATCH",
        { title: "改过的标题", expectedVersion: versionOf(state.current) },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("TICKET_OPERATION_PENDING");
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 业务意图：项目暂停只拦写（503），且必须在领取幂等键之前判定——一次 503 不该烧掉调用方的幂等键。
  test("项目暂停：503 且零上游调用", async () => {
    projectRow(harness, PROJECT_B).status = "paused";
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_B}/3`,
        "PATCH",
        { title: "改过的标题", expectedVersion: "a".repeat(64) },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("TICKETS_PAUSED");
    expect(harness.git.calls).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 业务意图：缺 Idempotency-Key 是稳定 400 IDEMPOTENCY_KEY_REQUIRED（不是通用校验错误），且不得产生任何写入。
  test("缺幂等键：400 IDEMPOTENCY_KEY_REQUIRED 且零写入", async () => {
    const state = stubIssueBackend(harness, initialIssue());
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`, "PATCH", {
        title: "改过的标题",
        expectedVersion: versionOf(state.current),
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 业务意图：上游写入结果未定（超时）必须给 202 + operationId，让调用方复核；压成失败会导致重复写入。
  test("上游结果未定：202 与 uncertain", async () => {
    stubIssueBackend(harness, initialIssue());
    harness.git.behaviour.editIssue = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`,
        "PATCH",
        { title: "改过的标题", expectedVersion: versionOf(initialIssue()) },
        IDEMPOTENCY_KEY,
      ),
    );
    const body = (await response.json()) as { data: { operationId: string; status: string } };

    expect(response.status).toBe(202);
    expect(body.data.status).toBe("uncertain");
    expect(body.data.operationId).toBeString();
  });

  // 业务意图：负责人的成员关系校验是领域规则（不因走管理面而放宽），非成员一律 400 且零写入。
  test("负责人不是组织成员：400 且零远端写入", async () => {
    const state = stubIssueBackend(harness, initialIssue());
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}`,
        "PATCH",
        { assigneeId: "user_ghost", expectedVersion: versionOf(state.current) },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("ASSIGNEE_NOT_MEMBER");
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 业务意图：跨组织坐标互不串——写乙组织的工单只在乙组织留下账本行，甲组织的索引一行不动。
  test("跨组织坐标：账本与索引落在被指向的组织", async () => {
    const state = stubIssueBackend(harness, initialIssue({ number: "3", title: "乙组织的工单" }));
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_B}/3`,
        "PATCH",
        { title: "乙改过", expectedVersion: versionOf(state.current) },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(200);
    expect(harness.operationStore.rows.map((row) => row.organizationId)).toEqual([ORG_B]);
    expect(harness.operationStore.rows.map((row) => row.projectId)).toEqual([PROJECT_B]);
    expect(harness.indexStore.rows.filter((row) => row.projectId === PROJECT_A).map((row) => row.issueNumber)).toEqual([
      ISSUE_NUMBER,
    ]);
  });
});
