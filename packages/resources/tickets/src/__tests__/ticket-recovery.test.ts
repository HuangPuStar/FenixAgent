import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GitError, type GitIssue } from "@fenix/git/server";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { OperationNotFoundError } from "../server/errors";
import { describeIssue } from "../server/services/ticket-issue-write";
import { RECOVERY_NEEDS_REVIEW_AFTER_MS, RECOVERY_SCAN_PAGE_LIMIT } from "../server/services/ticket-limits";
import { TICKET_OPERATION_STEP } from "../server/services/ticket-operation-service";
import {
  BINDING_A,
  createTicketHarness,
  DATABASE_STUB,
  fixtureBody,
  gitComment,
  gitIssue,
  ORG_A,
  PROJECT_A,
  stubDirectory,
  type TicketHarness,
  testActor,
} from "./ticket-harness";

/**
 * 恢复核对的契约（backend contract §12 `ticket-recovery.test.ts` / §8）。
 *
 * 三条不可动摇的口径在用例里各有一组断言：**只读远端**（每次核对都断言写方法调用数为 0）、**有界**
 * （扫描参数与超窗口的行为）、**找不到不判定失败**（保持原状态而不是 `failed`）。
 */

const ACTOR = "user_creator";
const ACTOR_NAME = "张创建";
const ISSUE_NUMBER = "42";
const MESSAGE_ID = "msg_crashed";
const SINCE = "2026-10-12T07:59:00.000Z";

/** 崩溃/超时前那次写入本应产生的远端工单：正文里的 `message_id` 与摘要都与操作行的 intent 对得上。 */
function createdIssue(body = "新建正文"): GitIssue {
  return gitIssue({
    number: ISSUE_NUMBER,
    title: "崩溃前创建的工单",
    body: fixtureBody({ messageId: MESSAGE_ID, authorId: ACTOR, authorName: ACTOR_NAME, body }),
  });
}

/** 单页列表替身；`pages` 为空表示「扫描窗口内没有匹配」。 */
function stubIssueScan(harness: TicketHarness, pages: ReadonlyArray<readonly GitIssue[]>): void {
  harness.git.behaviour.listIssues = async (_query) => ({
    items: pages[0] ?? [],
    nextCursor: pages.length > 1 ? "2" : null,
  });
}

async function setup(): Promise<{ readonly harness: TicketHarness }> {
  const members = [{ userId: ACTOR, name: ACTOR_NAME }];
  stubDirectory({ users: members, membersOf: { [ORG_A]: members } });
  const harness = createTicketHarness();
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A });
  return { harness };
}

/** 核对一次；断言集中在每个用例里，这里只负责调用形状。 */
async function reconcile(harness: TicketHarness, operationId: string) {
  return await harness.services.recovery.reconcile({ organizationId: ORG_A, actorId: ACTOR, operationId });
}

/**
 * 「窗口内」的账本行时间。
 *
 * 窗口判定（`now - created_at > 15min → needs_review`）用真实时钟，替身默认的 `FIXTURE_NOW` 是固定的过去
 * 时间，直接落进「超窗口」分支；凡是要断言「保持未定」的用例都必须显式给出近期时间。
 */
function withinWindow(): Date {
  return new Date(Date.now() - 60_000);
}

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
});

describe("恢复核对 — issue.create", () => {
  // 按 message_id + 摘要唯一命中：补齐索引与归属行并落成功终态，远端零写入（绝不二次创建）。
  test("唯一命中：补齐索引与归属行并置 succeeded", async () => {
    const { harness } = await setup();
    const remote = createdIssue();
    stubIssueScan(harness, [[remote]]);
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.create",
      actorId: ACTOR,
      projectId: PROJECT_A,
      targetId: null,
      messageId: MESSAGE_ID,
      intent: { title: remote.title, body: "新建正文", since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("settled");
    expect(row.status).toBe("succeeded");
    expect(row.step).toBe(TICKET_OPERATION_STEP.indexWritten);
    expect(row.targetId).toBe(ISSUE_NUMBER);
    // 扫描是有界的、从 since 起：无界扫描会在万级工单的仓库上把一次核对变成全量回放。
    expect(harness.git.ops("issues.list")[0]?.query).toEqual({
      state: "all",
      limit: RECOVERY_SCAN_PAGE_LIMIT,
      since: SINCE,
    });

    const index = harness.indexStore.rows[0];
    expect(index?.issueNumber).toBe(ISSUE_NUMBER);
    expect(index?.title).toBe(remote.title);
    expect(index?.contentVersion).toBe(describeIssue(remote).version);
    expect(index?.authorId).toBe(ACTOR);

    const ownership = harness.messageStore.rows[0];
    expect(ownership?.objectKind).toBe("issue");
    expect(ownership?.providerObjectId).toBe(ISSUE_NUMBER);
    expect(ownership?.messageId).toBe(MESSAGE_ID);
    expect(ownership?.authorId).toBe(ACTOR);
    expect(ownership?.authorNameSnapshot).toBe(ACTOR_NAME);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 同一个 message_id 命中两条：多义必须交人工，绝不猜其中一条（猜错就凭空多出一份数据）。
  test("同一 message_id 命中两条：needs_review", async () => {
    const { harness } = await setup();
    const remote = createdIssue();
    stubIssueScan(harness, [[remote, { ...remote, number: "43" }]]);
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.create",
      messageId: MESSAGE_ID,
      intent: { title: remote.title, body: "新建正文", since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("needs_review");
    expect(row.status).toBe("needs_review");
    expect(row.step).toBe(TICKET_OPERATION_STEP.needsReview);
    expect(harness.indexStore.rows).toEqual([]);
    expect(harness.messageStore.rows).toEqual([]);
  });

  // 窗口内没找到就保持原状态：既不能判失败（可能马上就出现），也不能再创建一份。
  test("窗口内未找到：保持 uncertain 且零写入", async () => {
    const { harness } = await setup();
    stubIssueScan(harness, [[]]);
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.create",
      messageId: MESSAGE_ID,
      createdAt: withinWindow(),
      intent: { title: "崩溃前创建的工单", body: "新建正文", since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("unchanged");
    expect(row.status).toBe("uncertain");
    expect(row.step).toBe(TICKET_OPERATION_STEP.dispatching);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 超过 15 分钟仍未找到：转 needs_review 交人工，状态不再停留在「稍后再说」。
  test("超窗口仍未找到：needs_review", async () => {
    const { harness } = await setup();
    stubIssueScan(harness, [[]]);
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.create",
      messageId: MESSAGE_ID,
      createdAt: new Date(Date.now() - RECOVERY_NEEDS_REVIEW_AFTER_MS - 60_000),
      intent: { title: "崩溃前创建的工单", body: "新建正文", since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("needs_review");
    expect(row.status).toBe("needs_review");
    expect(row.step).toBe(TICKET_OPERATION_STEP.needsReview);
  });

  // 上游读取失败是 503 而不是「未找到」：读不到就不能产生任何结论（否则一次网络抖动会把写入判成未落库）。
  test("回源读取失败：报 503 且不改状态", async () => {
    const { harness } = await setup();
    harness.git.behaviour.listIssues = async () => {
      throw new GitError("UNAVAILABLE", "上游不可达");
    };
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.create",
      messageId: MESSAGE_ID,
      intent: { title: "崩溃前创建的工单", body: "新建正文", since: SINCE },
    });

    await expect(reconcile(harness, row.id)).rejects.toThrow("托管平台不可用，请稍后重试");
    expect(row.status).toBe("uncertain");
  });
});

describe("恢复核对 — issue.update", () => {
  // 远端内容已经等于目标：这次修改其实成了，补齐索引与归属行走成功终态。
  test("远端内容等于目标：补齐成功", async () => {
    const { harness } = await setup();
    const remote = gitIssue({
      number: "1",
      title: "新标题",
      body: fixtureBody({ messageId: MESSAGE_ID, authorId: ACTOR, authorName: ACTOR_NAME, body: "新正文" }),
    });
    harness.git.behaviour.getIssue = async () => remote;
    const row = harness.operationStore.seed({
      status: "dispatching",
      kind: "issue.update",
      actorId: ACTOR,
      projectId: PROJECT_A,
      targetId: "1",
      messageId: MESSAGE_ID,
      intent: { title: "新标题", body: "新正文", expectedVersion: "0".repeat(64), since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("settled");
    expect(row.status).toBe("succeeded");
    expect(row.step).toBe(TICKET_OPERATION_STEP.indexWritten);
    expect(harness.indexStore.rows[0]?.contentVersion).toBe(describeIssue(remote).version);
    // 归属行按正文里的 message_id 补上，作者取操作行的主体（远端正文抄不走这个事实）。
    expect(harness.messageStore.rows[0]?.messageId).toBe(MESSAGE_ID);
    expect(harness.messageStore.rows[0]?.authorId).toBe(ACTOR);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 远端内容仍等于 expectedVersion：这次修改确定没生效，落 failed + WRITE_NOT_APPLIED（可安全换键重提）。
  test("远端内容等于 expectedVersion：failed + WRITE_NOT_APPLIED", async () => {
    const { harness } = await setup();
    const remote = gitIssue({
      number: "1",
      body: fixtureBody({ messageId: MESSAGE_ID, authorId: ACTOR, authorName: ACTOR_NAME, body: "旧正文" }),
    });
    harness.git.behaviour.getIssue = async () => remote;
    const row = harness.operationStore.seed({
      status: "dispatching",
      kind: "issue.update",
      actorId: ACTOR,
      projectId: PROJECT_A,
      targetId: "1",
      messageId: MESSAGE_ID,
      expectedVersion: describeIssue(remote).version,
      intent: {
        title: "新标题",
        body: "新正文",
        expectedVersion: describeIssue(remote).version,
        since: SINCE,
      },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("settled");
    expect(row.status).toBe("failed");
    expect(row.step).toBe(TICKET_OPERATION_STEP.notApplied);
    expect(row.result).toMatchObject({ code: "WRITE_NOT_APPLIED", statusCode: 409 });
    expect(harness.indexStore.rows).toEqual([]);
    expect(harness.git.writeCalls()).toEqual([]);
  });

  // 两者都不是（别人又改过）：保持未定而不是猜一个结论——猜错的代价是覆盖他人的修改。
  test("与目标与 expectedVersion 都不符：保持 uncertain", async () => {
    const { harness } = await setup();
    const remote = gitIssue({
      number: "1",
      title: "别人改的标题",
      body: fixtureBody({ messageId: "msg_other", authorId: ACTOR, authorName: ACTOR_NAME, body: "别人改的正文" }),
    });
    harness.git.behaviour.getIssue = async () => remote;
    const row = harness.operationStore.seed({
      status: "dispatching",
      kind: "issue.update",
      actorId: ACTOR,
      projectId: PROJECT_A,
      targetId: "1",
      messageId: MESSAGE_ID,
      createdAt: withinWindow(),
      intent: { title: "新标题", body: "新正文", expectedVersion: "0".repeat(64), since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("unchanged");
    expect(row.status).toBe("dispatching");
    expect(harness.indexStore.rows).toEqual([]);
    expect(harness.messageStore.rows).toEqual([]);
  });

  // 工单在远端不存在（被删除）：没有核对结论，保持未定交人工，不判定成功也不判定失败。
  test("工单已不存在：保持原状态", async () => {
    const { harness } = await setup();
    harness.git.behaviour.getIssue = async () => {
      throw new GitError("NOT_FOUND", "工单不存在", { status: 404 });
    };
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.update",
      targetId: "1",
      messageId: MESSAGE_ID,
      createdAt: withinWindow(),
      intent: { title: "新标题", since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("unchanged");
    expect(row.status).toBe("uncertain");
  });
});

describe("恢复核对 — comment.create", () => {
  // 评论核对按工单号翻页并带 `since`；命中后补归属行，并把操作坐标换成评论 ID。
  test("带 since 扫描命中：补归属行并把坐标换成评论 ID", async () => {
    const { harness } = await setup();
    const remote = gitComment({
      id: "9100",
      issueNumber: "1",
      body: fixtureBody({ messageId: MESSAGE_ID, authorId: ACTOR, authorName: ACTOR_NAME, body: "新评论" }),
    });
    harness.git.behaviour.listComments = async () => ({ items: [remote], nextCursor: null });
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "comment.create",
      actorId: ACTOR,
      projectId: PROJECT_A,
      // 领取时的坐标是工单号；核对命中后才换成评论 ID。
      targetId: "1",
      messageId: MESSAGE_ID,
      intent: { body: "新评论", issueNumber: "1", since: SINCE },
    });

    const outcome = await reconcile(harness, row.id);

    expect(outcome.kind).toBe("settled");
    expect(row.status).toBe("succeeded");
    expect(row.targetId).toBe("9100");
    expect(row.step).toBe(TICKET_OPERATION_STEP.ownershipWritten);
    expect(harness.git.ops("comments.list")[0]?.query).toEqual({ limit: RECOVERY_SCAN_PAGE_LIMIT, since: SINCE });
    expect(harness.messageStore.rows[0]?.objectKind).toBe("comment");
    expect(harness.messageStore.rows[0]?.providerObjectId).toBe("9100");
    expect(harness.messageStore.rows[0]?.authorId).toBe(ACTOR);
    expect(harness.git.writeCalls()).toEqual([]);
  });
});

describe("恢复核对 — 并发与可见性", () => {
  // 两个并发核对最多一个落终态：第二个进入事务后读到的是终态，直接返回而不写第二次结论。
  test("并发核对只有一个落终态", async () => {
    const { harness } = await setup();
    const remote = createdIssue();
    stubIssueScan(harness, [[remote]]);
    const row = harness.operationStore.seed({
      status: "uncertain",
      kind: "issue.create",
      actorId: ACTOR,
      projectId: PROJECT_A,
      messageId: MESSAGE_ID,
      intent: { title: remote.title, body: "新建正文", since: SINCE },
    });

    const [first, second] = await Promise.all([reconcile(harness, row.id), reconcile(harness, row.id)]);

    expect([first.kind, second.kind]).toEqual(["settled", "settled"]);
    expect(row.status).toBe("succeeded");
    // 归属行只落一条：若两次核对都执行了补齐，第二次插入会撞 `message_id` 唯一索引。
    expect(harness.messageStore.rows).toHaveLength(1);
    expect(harness.indexStore.rows).toHaveLength(1);
  });

  // 他人不可见的操作：查不到与不是本人同形 404，不给操作 ID 留探测面。
  test("不是本人的操作：404", async () => {
    const { harness } = await setup();
    const row = harness.operationStore.seed({ status: "uncertain", kind: "issue.create", actorId: "user_other" });

    await expect(reconcile(harness, row.id)).rejects.toThrow(OperationNotFoundError);
    expect(harness.git.calls).toEqual([]);
  });

  // 未定状态经 GET /ticket-operations/:id 的投影触发一次核对；终态行不再回源。
  test("详情视图对未定行触发一次核对、对终态行不触发", async () => {
    const { harness } = await setup();
    const remote = createdIssue();
    stubIssueScan(harness, [[remote]]);
    const pending = harness.operationStore.seed({
      status: "dispatching",
      kind: "issue.create",
      actorId: ACTOR,
      projectId: PROJECT_A,
      messageId: MESSAGE_ID,
      intent: { title: remote.title, body: "新建正文", since: SINCE },
    });
    const actor = testActor(ACTOR, ORG_A, "member");

    const view = await harness.api.tickets.getOperation(actor, pending.id);

    expect(view.status).toBe("succeeded");
    expect(harness.git.ops("issues.list")).toHaveLength(1);

    const settled = await harness.api.tickets.getOperation(actor, pending.id);
    expect(settled.status).toBe("succeeded");
    // 终态行不再回源：读接口不该为每次刷新都打一次上游。
    expect(harness.git.ops("issues.list")).toHaveLength(1);
  });
});
