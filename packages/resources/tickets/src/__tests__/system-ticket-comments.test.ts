import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitError } from "@fenix/git/server";
import {
  initializeTestApplicationInfrastructure,
  resetAllStubs,
  stubIdentityDirectory,
} from "@fenix/platform-sdk/testing";
import { resetTicketsServerModule } from "../server/runtime";
import { computeCommentVersion } from "../server/services/content-version";
import { parseTicketBody } from "../server/services/identity-header";
import {
  BINDING_A,
  BINDING_B,
  createTicketHarness,
  DATABASE_STUB,
  fixtureBody,
  gitComment,
  IDEMPOTENCY_KEY,
  installSystemTicketRoutes,
  ORG_A,
  ORG_B,
  PROJECT_A,
  PROJECT_B,
  seedOwnership,
  stubDirectory,
  type TicketHarness,
} from "./ticket-harness";

/**
 * `/api/system/tickets/:projectId/:number/comments*` 协议层用例（**平台管理面的评论**）。
 *
 * 与 `/web` 面同形的部分：倒序分页的游标语义、201/200/202、409 的版本冲突与幂等冲突、上游不可用 503（绝不
 * 返回空列表）、评论不属于该工单时 404。
 *
 * 本面**特有**的部分（都要在本文件里钉住）：
 *
 * 1. **凭据即判据**：无 key 时全部端点 401 且零读写；管理面没有「非原作者 403」这条分支——凭据握着就能改，
 *    因此这里断言的是「能改」而不是「被拒」，并把「作者身份不因平台改写而转移」写成身份头的断言；
 * 2. **审计主体**：发表评论的作者是系统托管租户（不是某个组织成员），归属行与身份头都写它；
 * 3. **跨组织坐标**：评论的读写只落在被指向项目的仓库绑定上。
 */

const SYSTEM_KEY = "sys-key-ticket-comments";
const SYSTEM_USER = "user_system_admin";
const ISSUE_NUMBER = "1";
const MESSAGE_ID = "msg_c1";

function systemRequest(path: string, init: RequestInit = {}): Request {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${SYSTEM_KEY}` },
  });
}

function jsonRequest(path: string, method: string, body: unknown, idempotencyKey?: string): Request {
  return systemRequest(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    body: JSON.stringify(body),
  });
}

/** 两个组织的项目：仓库绑定不同，才能看出评论的读写打到了哪一个组织的仓库。 */
function seedTwoOrganizations(harness: TicketHarness): void {
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A, name: "alpha-repo" });
  harness.projectStore.seed({ id: PROJECT_B, organizationId: ORG_B, repositoryRef: BINDING_B, name: "beta-repo" });
}

/** 一条由组织成员（`user_creator`）写的评论：身份头与归属行同源，才能被核验成 AOS 作者。 */
async function seedAuthoredComment(harness: TicketHarness, body = "原始评论"): Promise<void> {
  await seedOwnership({
    messages: harness.messageStore.repository,
    objectKind: "comment",
    providerObjectId: "9001",
    messageId: MESSAGE_ID,
    authorId: "user_creator",
    authorName: "张创建",
    body,
  });
  harness.git.behaviour.getComment = async () =>
    gitComment({
      id: "9001",
      issueNumber: ISSUE_NUMBER,
      body: fixtureBody({ messageId: MESSAGE_ID, authorId: "user_creator", authorName: "张创建", body }),
    });
}

/** 第 n 次评论写入实际发出去的正文；没有调用时直接失败，避免断言里到处写类型收窄。 */
function writtenBody(harness: TicketHarness, op: "comments.create" | "comments.edit", index = 0): string {
  const call = harness.git.ops(op)[index];
  if (call?.op !== "comments.create" && call?.op !== "comments.edit") {
    throw new Error(`Git 替身未记录第 ${index + 1} 次 ${op}`);
  }
  return call.input.body;
}

let harness: TicketHarness;

beforeEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
  harness = createTicketHarness();
  // 系统托管租户也在身份目录里：审计主体的**展示名**取它的当前值（写进归属行快照与身份头）。
  stubDirectory({
    users: [
      { id: "user_creator", name: "张创建" },
      { id: SYSTEM_USER, name: "平台系统管理员" },
    ],
  });
  stubIdentityDirectory({
    resolveSystemTenant: async () => ({
      organizationId: "org_admin",
      organizationSlug: "admin",
      userId: SYSTEM_USER,
      email: "admin@example.test",
    }),
  });
  seedTwoOrganizations(harness);
});

afterEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
});

describe("管理面评论 — 凭据即判据", () => {
  // 业务意图：评论的三条端点都在跨租户面上，无 key 时必须零读取零写入（评论正文是用户内容，泄露面比索引更大）。
  test("无 key 时全部端点 401 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);
    const requests = [
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
        body: JSON.stringify({ body: "新评论" }),
      }),
      new Request(`http://localhost/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments/9001`, {
        method: "PATCH",
        headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
        body: JSON.stringify({ body: "改", expectedVersion: "a".repeat(64) }),
      }),
    ];

    for (const request of requests) {
      const response = await app.handle(request);
      expect(response.status).toBe(401);
    }
    expect(harness.git.calls).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });
});

describe("管理面评论 — 列表", () => {
  // 业务意图：列表是评论区首屏，作者核验与倒序分页的对外形状必须与 web 面一致（前端复用同一套渲染与游标逻辑）。
  test("成功：返回倒序评论与游标", async () => {
    harness.git.behaviour.listComments = async () => ({
      items: [
        gitComment({ id: "9001", issueNumber: ISSUE_NUMBER, body: "更早的评论" }),
        gitComment({ id: "9002", issueNumber: ISSUE_NUMBER, body: "更新的评论" }),
      ],
      nextCursor: null,
      lastCursor: null,
    });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`));
    const body = (await response.json()) as {
      data: { items: Array<{ commentId: string; body: string }>; nextCursor: string | null };
    };

    expect(response.status).toBe(200);
    // 倒序：页内最新在前（上游按创建时间升序返回）。
    expect(body.data.items.map((item) => item.commentId)).toEqual(["9002", "9001"]);
    expect(body.data.nextCursor).toBeNull();
  });

  // 业务意图：上游不可用必须 503 而不是空列表——静默降级会让管理员以为评论被删了。
  test("上游不可用：503 而不是空列表", async () => {
    harness.git.behaviour.listComments = async () => {
      throw new GitError("UNAVAILABLE", "上游不可达");
    };
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("UNAVAILABLE");
  });

  // 业务意图：limit 越界由共享 schema 挡住（上限 100），非法查询在边界 400 且零上游调用。
  test("limit 越界：400 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      systemRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments?limit=500`),
    );

    expect(response.status).toBe(400);
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：跨组织坐标互不串——乙组织工单的评论只从乙组织的绑定读，甲组织仓库一次都不碰。
  test("跨组织坐标：只读被指向组织的仓库", async () => {
    harness.git.behaviour.listComments = async () => ({ items: [], nextCursor: null, lastCursor: null });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(systemRequest(`/api/system/tickets/${PROJECT_B}/3/comments`));

    expect(response.status).toBe(200);
    expect(harness.git.ops("createScopedClient").map((call) => call.bindingId)).toEqual([BINDING_B]);
  });
});

describe("管理面评论 — 发表", () => {
  // 业务意图：平台管理员要在工单里留言追问，因此发表必须有完整写路径；审计主体写真实系统租户，不是匿名。
  test("成功：201 + 评论视图，身份头与归属行都写系统租户", async () => {
    harness.git.behaviour.createComment = async (issueNumber, input) =>
      gitComment({ id: "9009", issueNumber, body: input.body });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`,
        "POST",
        { body: "平台侧追问" },
        IDEMPOTENCY_KEY,
      ),
    );
    const body = (await response.json()) as {
      data: { comment: { commentId: string; body: string; author: { id: string | null } }; operationId: string };
    };

    expect(response.status).toBe(201);
    expect(body.data.comment.commentId).toBe("9009");
    expect(body.data.comment.body.trimEnd()).toBe("平台侧追问");
    // 发表响应里的作者是 `external`（与 web 面同源：写入路径不回读刚落的归属行），作者事实要看身份头与归属行。
    expect(body.data.comment.author.id).toBeNull();
    expect(body.data.operationId).toBeString();
    const parsed = parseTicketBody(writtenBody(harness, "comments.create"));
    expect(parsed.header?.author.id).toBe(SYSTEM_USER);
    expect(harness.messageStore.rows[0]?.authorId).toBe(SYSTEM_USER);
    expect(harness.operationStore.rows[0]?.actorId).toBe(SYSTEM_USER);
  });

  // 业务意图：缺 Idempotency-Key 是稳定 400 IDEMPOTENCY_KEY_REQUIRED，且不得产生任何远端写入或账本行。
  test("缺幂等键：400 IDEMPOTENCY_KEY_REQUIRED 且零写入", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(`/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`, "POST", { body: "平台侧追问" }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 业务意图：请求体的作者字段必须被拒绝（strictObject），否则「作者由凭据决定」这条不变量会被前端误传破坏。
  test("请求体带作者字段：400 且零写入", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`,
        "POST",
        { body: "平台侧追问", authorId: "user_fake" },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(400);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 业务意图：上游结果未定时给 202 + operationId（调用方复核而不是重发），否则超时会导致重复评论。
  test("上游结果未定：202 与 uncertain", async () => {
    harness.git.behaviour.createComment = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`,
        "POST",
        { body: "平台侧追问" },
        IDEMPOTENCY_KEY,
      ),
    );
    const body = (await response.json()) as { data: { status: string; operationId: string } };

    expect(response.status).toBe(202);
    expect(body.data.status).toBe("uncertain");
    expect(body.data.operationId).toBeString();
  });

  // 业务意图：项目暂停只拦写（503）且零上游调用——暂停的组织不该因为管理面绕开而收到写入。
  test("项目暂停：503 且零上游调用", async () => {
    const paused = harness.projectStore.rows.find((row) => row.id === PROJECT_B);
    if (paused === undefined) throw new Error("用例未种 PROJECT_B");
    paused.status = "paused";
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(`/api/system/tickets/${PROJECT_B}/3/comments`, "POST", { body: "平台侧追问" }, IDEMPOTENCY_KEY),
    );

    expect(response.status).toBe(503);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("TICKETS_PAUSED");
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：跨组织坐标互不串——乙组织工单下的评论只写进乙组织的绑定与账本。
  test("跨组织坐标：写入落在被指向组织的仓库", async () => {
    harness.git.behaviour.createComment = async (issueNumber, input) =>
      gitComment({ id: "9009", issueNumber, body: input.body });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(`/api/system/tickets/${PROJECT_B}/3/comments`, "POST", { body: "乙组织留言" }, IDEMPOTENCY_KEY),
    );

    expect(response.status).toBe(201);
    expect(harness.git.ops("createScopedClient").map((call) => call.bindingId)).toEqual([BINDING_B]);
    expect(harness.operationStore.rows.map((row) => row.organizationId)).toEqual([ORG_B]);
    expect(harness.operationStore.rows.map((row) => row.projectId)).toEqual([PROJECT_B]);
  });
});

describe("管理面评论 — 修改", () => {
  // 业务意图：管理面改评论没有「非原作者 403」这条规则（凭据即判据），但**编辑主体必须显式记成平台审计主体**
  // （账本的发起人与归属行的 last_editor_id），且作者不得因此转移——身份头沿用归属行里的原始主体。
  test("成功：非原作者也能改，编辑主体记为系统租户且作者不转移", async () => {
    await seedAuthoredComment(harness);
    harness.git.behaviour.editComment = async (commentId, input) =>
      gitComment({ id: commentId, issueNumber: ISSUE_NUMBER, body: input.body });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments/9001`,
        "PATCH",
        { body: "平台侧改写", expectedVersion: computeCommentVersion("原始评论") },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(200);
    const parsed = parseTicketBody(writtenBody(harness, "comments.edit"));
    // 改写不转移作者：头部的 message_id 与作者仍是归属行里那一份。
    expect(parsed.header?.messageId).toBe(MESSAGE_ID);
    expect(parsed.header?.author.id).toBe("user_creator");
    expect(parsed.body.trimEnd()).toBe("平台侧改写");
    // 「谁在编辑」两处留痕：账本的发起人与归属行的 last_editor_id 都是系统租户（平台系统管理员）。
    expect(harness.operationStore.rows[0]?.actorId).toBe(SYSTEM_USER);
    expect(harness.operationStore.rows[0]?.kind).toBe("comment.update");
    const row = harness.messageStore.rows[0];
    expect(row?.authorId).toBe("user_creator");
    expect(row?.lastEditorId).toBe(SYSTEM_USER);
    expect(row?.revision).toBe(2);
  });

  // 业务意图：外部来源评论（没有归属行）由平台侧编辑时，新落的归属行必须认成**平台审计主体**而不是原作者，
  // 否则「这条评论是谁写的」会被一次编辑悄悄改写。
  test("外部来源评论：编辑后按系统租户补归属行", async () => {
    harness.git.behaviour.getComment = async () =>
      gitComment({ id: "9002", issueNumber: ISSUE_NUMBER, body: "外部评论" });
    harness.git.behaviour.editComment = async (commentId, input) =>
      gitComment({ id: commentId, issueNumber: ISSUE_NUMBER, body: input.body });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments/9002`,
        "PATCH",
        { body: "平台侧改写", expectedVersion: computeCommentVersion("外部评论") },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(200);
    const row = harness.messageStore.rows[0];
    expect(row?.providerObjectId).toBe("9002");
    expect(row?.authorId).toBe(SYSTEM_USER);
    expect(row?.authorNameSnapshot).toBe("平台系统管理员");
  });

  // 业务意图：内容指纹不符是 409 VERSION_CONFLICT 且不产生任何写入，调用方重新读取后再提交。
  test("版本冲突：409 且零远端写入", async () => {
    await seedAuthoredComment(harness);
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments/9001`,
        "PATCH",
        { body: "平台侧改写", expectedVersion: "a".repeat(64) },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(409);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("VERSION_CONFLICT");
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 业务意图：评论不属于该工单与评论不存在同形 404，不给跨工单的评论 ID 留探测面。
  test("评论不属于该工单：404 且零远端写入", async () => {
    harness.git.behaviour.getComment = async () =>
      gitComment({
        id: "9001",
        issueNumber: "2",
        body: fixtureBody({
          messageId: MESSAGE_ID,
          authorId: "user_creator",
          authorName: "张创建",
          body: "别的工单下的评论",
        }),
      });
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments/9001`,
        "PATCH",
        { body: "平台侧改写", expectedVersion: computeCommentVersion("别的工单下的评论") },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(404);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 业务意图：expectedVersion 形状非法（非 sha256 十六进制）在边界 400，不进入回源比较。
  test("expectedVersion 形状非法：400 且零上游调用", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments/9001`,
        "PATCH",
        { body: "平台侧改写", expectedVersion: "not-a-version" },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(400);
    expect(harness.git.calls).toEqual([]);
  });

  // 业务意图：评论 ID 形状非法（非十进制串）在边界 400，不落到上游的 404 判定上。
  test("评论 ID 非十进制串：400", async () => {
    const app = installSystemTicketRoutes(harness, SYSTEM_KEY);

    const response = await app.handle(
      jsonRequest(
        `/api/system/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments/abc`,
        "PATCH",
        { body: "平台侧改写", expectedVersion: "a".repeat(64) },
        IDEMPOTENCY_KEY,
      ),
    );

    expect(response.status).toBe(400);
  });
});
