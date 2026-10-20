import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type GitComment, GitError } from "@fenix/git/server";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import Elysia from "elysia";
import { VersionConflictError } from "../server/errors";
import { resetTicketsServerModule } from "../server/runtime";
import { computeCommentVersion } from "../server/services/content-version";
import { parseTicketBody } from "../server/services/identity-header";
import { TICKET_OPERATION_STEP } from "../server/services/ticket-operation-service";
import {
  BINDING_A,
  createTicketHarness,
  DATABASE_STUB,
  fixtureBody,
  gitComment,
  IDEMPOTENCY_KEY,
  installTicketRoutes,
  ORG_A,
  ORG_B,
  PROJECT_A,
  seedOwnership,
  stubDirectory,
  type TicketHarness,
  testActor,
} from "./ticket-harness";

/**
 * 评论路径的契约（backend contract §12 `ticket-comments.test.ts` / §3.2 / §4.4 / §12 倒序分页）。
 *
 * 倒序分页是本文件最容易被写错的一段：适配器按创建时间升序返回，而接口对外是「首屏即最新」。因此断言
 * 分两层——传给适配器的 `cursor` / `limit`（机制）与响应里的 `nextCursor`（对外的游标语义）。
 */

const AUTHOR = "user_creator";
const ADMIN = "user_admin";
const OTHER = "user_other";
const ISSUE_NUMBER = "1";

/** 无身份头的评论（外部来源形态）。 */
function plainComment(id: string, body: string): GitComment {
  return gitComment({ id, issueNumber: ISSUE_NUMBER, body, author: { id: `ext-${id}`, name: "外部评论者" } });
}

/**
 * 评论分页替身：升序切页、`cursor` 是页码、`lastCursor` 只在多页时给出。
 *
 * 与适配器同形（`Link` 头缺失的单页仓库不发末页页码），否则「首屏取末页」的退化分支永远走不到。
 */
function stubCommentPages(harness: TicketHarness, comments: readonly GitComment[]): void {
  harness.git.behaviour.listComments = async (_issueNumber, query) => {
    const limit = query.limit ?? 30;
    const totalPages = Math.max(1, Math.ceil(comments.length / limit));
    const requested =
      query.cursor === undefined || query.cursor === null ? 1 : Number.parseInt(String(query.cursor), 10);
    const start = (requested - 1) * limit;
    return {
      items: comments.slice(start, start + limit),
      nextCursor: requested < totalPages ? String(requested + 1) : null,
      lastCursor: totalPages > 1 ? String(totalPages) : null,
    };
  };
}

/** 传给适配器的评论列表查询入参；断言「原样透传」用它而不是逐字段取。 */
function listQueries(harness: TicketHarness): ReadonlyArray<Record<string, unknown>> {
  return harness.git.ops("comments.list").map((call) => call.query);
}

/** `comments.create` / `comments.edit` 实际写出去的正文；没有调用时直接失败。 */
function writtenBody(harness: TicketHarness, op: "comments.create" | "comments.edit", index = 0): string {
  const call = harness.git.ops(op)[index];
  if (call === undefined) throw new Error(`Git 替身未记录第 ${index + 1} 次 ${op}`);
  return call.op === "comments.create" || call.op === "comments.edit" ? call.input.body : "";
}

async function setup(): Promise<{
  readonly harness: TicketHarness;
  readonly author: ReturnType<typeof testActor>;
  readonly admin: ReturnType<typeof testActor>;
  readonly other: ReturnType<typeof testActor>;
}> {
  const members = [
    { userId: AUTHOR, name: "张创建" },
    { userId: ADMIN, name: "王管理" },
    { userId: OTHER, name: "李其他" },
  ];
  stubDirectory({ users: members, membersOf: { [ORG_A]: members } });
  const harness = createTicketHarness();
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A });
  return {
    harness,
    author: testActor(AUTHOR, ORG_A, "member"),
    admin: testActor(ADMIN, ORG_A, "owner"),
    other: testActor(OTHER, ORG_A, "member"),
  };
}

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
  resetTicketsServerModule();
});

describe("评论列表 — 倒序分页", () => {
  // 首屏必须直接取末页（最新 30 条），而不是从第一页开始翻：万级讨论串下后者等于把最旧的评论当首屏。
  test("首屏取末页、游标逐页递减、limit 与 nextCursor 直通", async () => {
    const { harness, author } = await setup();
    stubCommentPages(
      harness,
      [1, 2, 3, 4, 5].map((index) => plainComment(`900${index}`, `评论 ${index}`)),
    );

    const first = await harness.api.comments.list(author, PROJECT_A, ISSUE_NUMBER, { limit: 2 });
    // 机制：先探末页页码（第 1 页请求），再直接取末页；两页之外绝不扫描。
    expect(listQueries(harness)).toEqual([{ limit: 2 }, { cursor: "3", limit: 2 }]);
    expect(first.items.map((item) => item.commentId)).toEqual(["9005"]);
    expect(first.nextCursor).toBe("2");

    const second = await harness.api.comments.list(author, PROJECT_A, ISSUE_NUMBER, { cursor: "2", limit: 2 });
    expect(listQueries(harness)[2]).toEqual({ cursor: "2", limit: 2 });
    // 页内同样是「最新在前」，否则前端把整串正序渲染后会看到时间倒流。
    expect(second.items.map((item) => item.commentId)).toEqual(["9004", "9003"]);
    expect(second.nextCursor).toBe("1");

    const third = await harness.api.comments.list(author, PROJECT_A, ISSUE_NUMBER, { cursor: "1", limit: 2 });
    expect(third.items.map((item) => item.commentId)).toEqual(["9002", "9001"]);
    expect(third.nextCursor).toBeNull();
  });

  // 单页仓库（上游不发 Link 头）退化为「第 1 页就是全部」，不得凭空猜一个末页页码。
  test("末页页码缺失：按单页返回并结束", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.listComments = async () => ({
      items: [plainComment("9001", "唯一一条")],
      nextCursor: null,
      lastCursor: null,
    });

    const page = await harness.api.comments.list(author, PROJECT_A, ISSUE_NUMBER, { limit: 30 });
    expect(listQueries(harness)).toEqual([{ limit: 30 }]);
    expect(page.items.map((item) => item.commentId)).toEqual(["9001"]);
    expect(page.nextCursor).toBeNull();
  });
});

describe("评论列表 — 正文与作者核验", () => {
  // 归属行与摘要同时吻合才算 AOS 作者；任何一处对不上都退化为外部来源且 authorId 为 null。
  test("正文剥离身份头，作者核验 aos 与 external 两路", async () => {
    const { harness, author } = await setup();
    await seedOwnership({
      messages: harness.messageStore.repository,
      objectKind: "comment",
      providerObjectId: "9001",
      messageId: "msg_c1",
      authorId: AUTHOR,
      authorName: "张创建",
      body: "AOS 评论",
    });
    stubCommentPages(harness, [
      gitComment({
        id: "9001",
        issueNumber: ISSUE_NUMBER,
        body: fixtureBody({ messageId: "msg_c1", authorId: AUTHOR, authorName: "张创建", body: "AOS 评论" }),
        author: { id: "ext-1", name: "外部评论者" },
      }),
      // 摘要对不上（远端正文被外部改写）：归属行还在，但已不能证明这条内容由 AOS 写入。
      gitComment({
        id: "9002",
        issueNumber: ISSUE_NUMBER,
        body: fixtureBody({ messageId: "msg_c2", authorId: AUTHOR, authorName: "张创建", body: "被改写的评论" }),
        author: { id: "ext-2", name: "外部评论者" },
      }),
      plainComment("9003", "外部直写的评论"),
    ]);
    await seedOwnership({
      messages: harness.messageStore.repository,
      objectKind: "comment",
      providerObjectId: "9002",
      messageId: "msg_c2",
      authorId: AUTHOR,
      authorName: "张创建",
      body: "原始评论",
    });

    const page = await harness.api.comments.list(author, PROJECT_A, ISSUE_NUMBER, { limit: 30 });
    const byId = new Map(page.items.map((item) => [item.commentId, item]));

    // 正文按解析结果原样返回（gray-matter 序列化会补一个尾换行，前端渲染层忽略），因此用 trimEnd 对齐。
    expect(byId.get("9001")?.body.trimEnd()).toBe("AOS 评论");
    expect(byId.get("9001")?.author).toEqual({ id: AUTHOR, name: "张创建", source: "aos" });
    expect(byId.get("9002")?.body.trimEnd()).toBe("被改写的评论");
    expect(byId.get("9002")?.author).toEqual({ id: null, name: "外部评论者", source: "external" });
    expect(byId.get("9003")?.author).toEqual({ id: null, name: "外部评论者", source: "external" });
    expect(byId.get("9001")?.version).toBe(computeCommentVersion("AOS 评论"));
  });

  // N 条评论只允许一次批量归属查询：逐条查询会让 30 条的首屏产生 30 次本地往返。
  test("一次列表只发一次批量归属查询", async () => {
    const { harness, author } = await setup();
    stubCommentPages(
      harness,
      [1, 2, 3].map((index) => plainComment(`900${index}`, `评论 ${index}`)),
    );

    await harness.api.comments.list(author, PROJECT_A, ISSUE_NUMBER, { limit: 30 });
    expect(harness.messageStore.batchQueries).toBe(1);
  });

  // 跨组织项目与不存在同形 404，且连绑定都不打开。
  test("跨组织项目：404 且 Git 零调用", async () => {
    const { harness } = await setup();
    const outsider = testActor("user_beta", ORG_B, "owner");

    await expect(harness.api.comments.list(outsider, PROJECT_A, ISSUE_NUMBER, { limit: 30 })).rejects.toThrow(
      NotFoundError,
    );
    expect(harness.git.calls).toEqual([]);
  });
});

describe("评论写入 — 创建", () => {
  // 创建评论：身份头带操作者与 message_id，归属行按评论 ID 落 `object_kind = "comment"`，远端只写一次。
  test("创建评论：身份头与 message_id 落库、远端只调一次 comments.create", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.createComment = async (_issueNumber, input) =>
      gitComment({ id: "9100", issueNumber: ISSUE_NUMBER, body: input.body });

    const outcome = await harness.api.comments.create(
      author,
      PROJECT_A,
      ISSUE_NUMBER,
      { body: "新评论" },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("written");
    expect(harness.git.ops("comments.create")).toHaveLength(1);
    const parsed = parseTicketBody(writtenBody(harness, "comments.create"));
    expect(parsed.body.trimEnd()).toBe("新评论");
    expect(parsed.header?.author.id).toBe(AUTHOR);
    expect(parsed.header?.messageId).toMatch(/^msg_/);

    const row = harness.messageStore.rows[0];
    expect(row?.objectKind).toBe("comment");
    expect(row?.providerObjectId).toBe("9100");
    expect(row?.messageId).toBe(parsed.header?.messageId);
    expect(row?.authorId).toBe(AUTHOR);
    expect(row?.revision).toBe(1);

    const operation = harness.operationStore.rows[0];
    expect(operation?.status).toBe("succeeded");
    expect(operation?.step).toBe(TICKET_OPERATION_STEP.ownershipWritten);
    // 成功终态的坐标是**创建出来的评论**：恢复核对与重放都要按它读回同一条评论。
    expect(operation?.targetId).toBe("9100");
    expect(outcome.kind === "written" ? outcome.comment.commentId : null).toBe("9100");
  });

  // 同键重放只允许一次远端读取：重复提交不能变成第二条评论。
  test("创建重放：同键不二次出站且返回同一 operationId", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.createComment = async (_issueNumber, input) =>
      gitComment({ id: "9100", issueNumber: ISSUE_NUMBER, body: input.body });
    harness.git.behaviour.getComment = async (commentId) =>
      gitComment({ id: commentId, issueNumber: ISSUE_NUMBER, body: "远端已有正文" });

    const first = await harness.api.comments.create(
      author,
      PROJECT_A,
      ISSUE_NUMBER,
      { body: "新评论" },
      IDEMPOTENCY_KEY,
    );
    const second = await harness.api.comments.create(
      author,
      PROJECT_A,
      ISSUE_NUMBER,
      { body: "新评论" },
      IDEMPOTENCY_KEY,
    );

    expect(second.operationId).toBe(first.operationId);
    expect(harness.git.ops("comments.create")).toHaveLength(1);
    expect(harness.git.ops("comments.get")).toHaveLength(1);
    expect(harness.messageStore.rows).toHaveLength(1);
  });

  // 远端结果未定：202 + 账本落 uncertain，绝不重发。
  test("创建 WRITE_UNCERTAIN：202 且账本落 uncertain", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.createComment = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };

    const outcome = await harness.api.comments.create(
      author,
      PROJECT_A,
      ISSUE_NUMBER,
      { body: "新评论" },
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toMatchObject({ kind: "uncertain" });
    expect(harness.operationStore.rows[0]?.status).toBe("uncertain");
    expect(harness.operationStore.rows[0]?.step).toBe(TICKET_OPERATION_STEP.dispatching);
    expect(harness.messageStore.rows).toEqual([]);
  });

  // 协议层：未定写入必须是 202 而不是 200/201——前端据此进入「提交结果确认中」而不是当成成功。
  test("路由层：创建评论未定时返回 202 与 operationId", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.createComment = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const response = await app.handle(
      new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": IDEMPOTENCY_KEY },
        body: JSON.stringify({ body: "新评论" }),
      }),
    );

    expect(response.status).toBe(202);
    const payload = (await response.json()) as { success: boolean; data: { operationId: string; status: string } };
    expect(payload.success).toBe(true);
    expect(payload.data.status).toBe("uncertain");
    expect(payload.data.operationId).toBeString();
  });

  // 上游不可用必须映射成 503 而不是空列表：静默降级会让用户以为评论被删了。
  test("路由层：列表上游不可用返回 503 而不是空页", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.listComments = async () => {
      throw new GitError("UNAVAILABLE", "上游不可达");
    };
    const app = new Elysia().use(installTicketRoutes(harness, author));

    const response = await app.handle(new Request(`http://localhost/tickets/${PROJECT_A}/${ISSUE_NUMBER}/comments`));

    expect(response.status).toBe(503);
    const payload = (await response.json()) as { success: boolean; error: { code: string } };
    expect(payload.success).toBe(false);
    expect(payload.error.code).toBe("UNAVAILABLE");
  });
});

describe("评论写入 — 编辑", () => {
  /** 建一条 AOS 作者自己的评论（归属行 + 身份头都对得上）。 */
  async function seedAuthoredComment(harness: TicketHarness, body = "原始评论"): Promise<void> {
    await seedOwnership({
      messages: harness.messageStore.repository,
      objectKind: "comment",
      providerObjectId: "9001",
      messageId: "msg_c1",
      authorId: AUTHOR,
      authorName: "张创建",
      body,
    });
    harness.git.behaviour.getComment = async () =>
      gitComment({
        id: "9001",
        issueNumber: ISSUE_NUMBER,
        body: fixtureBody({ messageId: "msg_c1", authorId: AUTHOR, authorName: "张创建", body }),
      });
    harness.git.behaviour.editComment = async (commentId, input) =>
      gitComment({ id: commentId, issueNumber: ISSUE_NUMBER, body: input.body });
  }

  // 原作者编辑自己的评论：身份头沿用归属行的 message_id 与作者（编辑不转移作者），归属行 revision+1。
  test("原作者可编辑：身份头沿用归属行、revision+1 且记录改写者", async () => {
    const { harness, author } = await setup();
    await seedAuthoredComment(harness);

    const outcome = await harness.api.comments.update(
      author,
      PROJECT_A,
      ISSUE_NUMBER,
      "9001",
      { body: "改过的评论", expectedVersion: computeCommentVersion("原始评论") },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("written");
    const parsed = parseTicketBody(writtenBody(harness, "comments.edit"));
    expect(parsed.header?.messageId).toBe("msg_c1");
    expect(parsed.header?.author.id).toBe(AUTHOR);
    expect(parsed.body.trimEnd()).toBe("改过的评论");

    const row = harness.messageStore.rows[0];
    expect(row?.authorId).toBe(AUTHOR);
    expect(row?.revision).toBe(2);
    expect(row?.lastEditorId).toBe(AUTHOR);
    expect(harness.operationStore.rows[0]?.step).toBe(TICKET_OPERATION_STEP.ownershipWritten);
  });

  // 管理员可以编辑外部来源的评论（治理入口）：本地此前没有归属行，编辑后按操作者补一条。
  test("管理员可编辑外部来源评论并补归属行", async () => {
    const { harness, admin } = await setup();
    harness.git.behaviour.getComment = async () =>
      gitComment({ id: "9002", issueNumber: ISSUE_NUMBER, body: "外部评论" });
    harness.git.behaviour.editComment = async (commentId, input) =>
      gitComment({ id: commentId, issueNumber: ISSUE_NUMBER, body: input.body });

    const outcome = await harness.api.comments.update(
      admin,
      PROJECT_A,
      ISSUE_NUMBER,
      "9002",
      { body: "管理员修订", expectedVersion: computeCommentVersion("外部评论") },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("written");
    const parsed = parseTicketBody(writtenBody(harness, "comments.edit"));
    expect(parsed.header?.author.id).toBe(ADMIN);
    expect(harness.messageStore.rows[0]?.providerObjectId).toBe("9002");
    expect(harness.messageStore.rows[0]?.authorId).toBe(ADMIN);
  });

  // 非原作者且非管理员：403 且零出站（判定在服务端，不靠前端隐藏入口）。
  test("他人编辑：403 且零远端写入", async () => {
    const { harness, other } = await setup();
    await seedAuthoredComment(harness);

    await expect(
      harness.api.comments.update(
        other,
        PROJECT_A,
        ISSUE_NUMBER,
        "9001",
        { body: "越权改写", expectedVersion: computeCommentVersion("原始评论") },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 「评论不属于该工单」与「评论不存在」同形 404：否则就成了跨工单评论 ID 的探测面。
  test("评论不属于该工单：404 且零写入", async () => {
    const { harness, admin } = await setup();
    harness.git.behaviour.getComment = async () =>
      gitComment({ id: "9001", issueNumber: "2", body: "别的工单下的评论" });

    await expect(
      harness.api.comments.update(
        admin,
        PROJECT_A,
        ISSUE_NUMBER,
        "9001",
        { body: "改", expectedVersion: computeCommentVersion("别的工单下的评论") },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(NotFoundError);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 版本过期的判定在领取之前：不产生账本行，用户换版本重试不会被自己的幂等键挡住。
  test("版本过期：409 且不产生账本行", async () => {
    const { harness, author } = await setup();
    await seedAuthoredComment(harness);

    await expect(
      harness.api.comments.update(
        author,
        PROJECT_A,
        ISSUE_NUMBER,
        "9001",
        { body: "改过的评论", expectedVersion: "0".repeat(64) },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(VersionConflictError);
    expect(harness.operationStore.rows).toEqual([]);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 评论已被删除（上游 NOT_FOUND）是 404，不是 503：读路径不给「过会儿再试」的假线索。
  test("上游 NOT_FOUND：404（评论已被删除）", async () => {
    const { harness, author } = await setup();
    harness.git.behaviour.getComment = async () => {
      throw new GitError("NOT_FOUND", "评论不存在", { status: 404 });
    };

    await expect(
      harness.api.comments.update(
        author,
        PROJECT_A,
        ISSUE_NUMBER,
        "9001",
        { body: "改过的评论", expectedVersion: computeCommentVersion("原始评论") },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(NotFoundError);
  });

  // 绑定不可用时编辑是确定的失败：账本写 failed 并还原同一个错误，不产生 202。
  test("上游写失败（确定）：账本写 failed 且抛出映射错误", async () => {
    const { harness, author } = await setup();
    await seedAuthoredComment(harness);
    harness.git.behaviour.editComment = async () => {
      throw new GitError("FORBIDDEN", "当前凭据无权修改该评论", { status: 403 });
    };

    await expect(
      harness.api.comments.update(
        author,
        PROJECT_A,
        ISSUE_NUMBER,
        "9001",
        { body: "改过的评论", expectedVersion: computeCommentVersion("原始评论") },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow("当前凭据无权修改该评论");
    expect(harness.operationStore.rows[0]?.status).toBe("failed");
  });

  // 跨组织项目下的评论 ID 与「评论不存在」同形 404：评论标识不得成为跨组织的存在性探测面（且零出站）。
  test("编辑跨组织：404 且 Git 零调用", async () => {
    const { harness } = await setup();
    const outsider = testActor("user_beta", ORG_B, "owner");

    await expect(
      harness.api.comments.update(
        outsider,
        PROJECT_A,
        ISSUE_NUMBER,
        "9001",
        { body: "越权改写", expectedVersion: computeCommentVersion("原始评论") },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(NotFoundError);
    expect(harness.git.calls).toEqual([]);
  });
});
