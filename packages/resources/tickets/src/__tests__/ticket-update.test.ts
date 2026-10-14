import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type EditIssueInput, GitError, type GitIssue } from "@fenix/git/server";
import { NotFoundError } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { TicketUpdateRequestSchema } from "../schemas/ticket.schema";
import {
  AssigneeNotMemberError,
  IdempotencyConflictError,
  TicketChangeInFlightError,
  VersionConflictError,
} from "../server/errors";
import { parseTicketBody } from "../server/services/identity-header";
import { describeIssue } from "../server/services/ticket-issue-write";
import { TICKET_OPERATION_STEP } from "../server/services/ticket-operation-service";
import {
  BINDING_A,
  createTicketHarness,
  DATABASE_STUB,
  fixtureBody,
  GIT_LABELS,
  gitIssue,
  IDEMPOTENCY_KEY,
  ORG_A,
  ORG_B,
  PROJECT_A,
  seedOwnership,
  stubDirectory,
  type TicketHarness,
  testActor,
} from "./ticket-harness";

/**
 * 工单修改（PATCH）的可靠性契约（backend contract §12 `ticket-update.test.ts` / §4.2 / §5 / §6.2 / §9.7）。
 *
 * 接缝说明：领域服务与操作账本用真实实现（要验证的正是两次版本比较的先后、幂等裁决顺序与失败收敛），
 * 只把 Git、身份目录与四个仓储换成记录型替身。断言分三层——远端收到了什么（`git.writeCalls()`）、账本
 * 变成了什么（`operationStore.rows`）、本地行变成了什么（`indexStore.rows` / `messageStore.rows`）。
 */

const CREATOR = "user_creator";
const ADMIN = "user_admin";
const OTHER = "user_other";
const ISSUE_NUMBER = "1";
const MESSAGE_ID = "msg_0001";
const INITIAL_BODY = "初始正文";
const CREATOR_NAME = "张创建";

/** 远端工单的初始形态：正文带可信身份头，作者归属由 `seedOwnership` 的归属行承认。 */
function initialIssue(overrides: Partial<GitIssue> = {}): GitIssue {
  return gitIssue({
    number: ISSUE_NUMBER,
    title: "预览页打不开",
    body: fixtureBody({
      messageId: MESSAGE_ID,
      authorId: CREATOR,
      authorName: CREATOR_NAME,
      body: INITIAL_BODY,
    }),
    ...overrides,
  });
}

/** 当前远端内容对应的期望版本；每次写入后必须重新取，不能缓存最初那个。 */
function versionOf(issue: GitIssue): string {
  return describeIssue(issue).version;
}

/** 取第 n 次 `issues.edit` 的入参；没有则直接失败，避免在断言里到处写类型收窄。 */
function editInput(harness: TicketHarness, index = 0): EditIssueInput {
  const call = harness.git.ops("issues.edit")[index];
  if (call?.op !== "issues.edit") throw new Error(`Git 替身未记录第 ${index + 1} 次 issues.edit`);
  return call.input;
}

/**
 * Git 替身按 Forgejo 语义回显写入：`issues.edit` 与 `issues.setLabels` 把入参合并进当前工单。
 *
 * 替身若不这么做，「回源算出的新版本」就成了用例自己编的值，版本断言会失去意义。
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
  harness.git.behaviour.setLabels = async (_issueNumber, names) => {
    // 标签只按名字回显：ID → 名称的映射由写路径的 `labels.list` 先验给出（`GIT_LABELS`）。
    const byName = new Map(GIT_LABELS.map((label) => [label.name, label]));
    state.current = {
      ...state.current,
      labels: names.map((name) => byName.get(name) ?? { id: "0", name, color: null, description: null }),
    };
    return state.current;
  };
  harness.git.behaviour.listLabels = async () => GIT_LABELS;
  return state;
}

/** 装配：项目行 + 组织成员投影 + 远端工单 + 归属行；`withOwnership: false` 用于构造外部来源工单。 */
async function setup(options: { readonly withOwnership?: boolean } = {}): Promise<{
  readonly harness: TicketHarness;
  readonly remote: { current: GitIssue };
  readonly creator: ReturnType<typeof testActor>;
  readonly admin: ReturnType<typeof testActor>;
}> {
  const members = [
    { userId: CREATOR, name: CREATOR_NAME },
    { userId: ADMIN, name: "王管理" },
    { userId: OTHER, name: "李其他" },
  ];
  stubDirectory({ users: members, membersOf: { [ORG_A]: members } });
  const harness = createTicketHarness();
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A });
  if (options.withOwnership ?? true) {
    await seedOwnership({
      messages: harness.messageStore.repository,
      objectKind: "issue",
      providerObjectId: ISSUE_NUMBER,
      messageId: MESSAGE_ID,
      authorId: CREATOR,
      authorName: CREATOR_NAME,
      body: INITIAL_BODY,
    });
  }
  const remote = stubIssueBackend(harness, initialIssue());
  return { harness, remote, creator: testActor(CREATOR, ORG_A, "member"), admin: testActor(ADMIN, ORG_A, "owner") };
}

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
});

describe("工单修改 — 部分字段 PATCH", () => {
  // 仅改标题时只发送 title：多带一个字段就会把别人刚改的描述覆盖回旧值（静默覆盖）。
  test("仅改标题：只发 title、刷新索引与版本、不动归属行", async () => {
    const { harness, remote, creator } = await setup();
    const before = harness.messageStore.rows[0];

    const outcome = await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), title: "新标题" },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("updated");
    // 未传递的字段必须**缺席**而不是被填成空值：缺席是「不改」，空串是「改成空」。
    expect(Object.keys(editInput(harness))).toEqual(["title"]);
    expect(editInput(harness).title).toBe("新标题");
    expect(harness.git.ops("issues.edit")).toHaveLength(1);

    const row = harness.indexStore.rows[0];
    expect(row?.title).toBe("新标题");
    expect(row?.contentVersion).toBe(versionOf(remote.current));
    // 标题不改正文：归属行的摘要与版本必须原样。
    expect(harness.messageStore.rows).toHaveLength(1);
    expect(harness.messageStore.rows[0]?.revision).toBe(before?.revision);
    expect(harness.messageStore.rows[0]?.bodyHash).toBe(before?.bodyHash);
  });

  // 改描述走「沿用归属行作者与 message_id」的分支：编辑不转移作者，也不换 message_id（换 id 会让恢复核对找不到这条操作）。
  test("改描述：身份头沿用归属行作者与 message_id，归属行 revision+1 且记录改写者", async () => {
    const { harness, admin } = await setup();

    const outcome = await harness.api.tickets.update(
      admin,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), body: "管理员改过的正文" },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("updated");
    const written = editInput(harness).body;
    expect(written).toBeDefined();
    const parsed = parseTicketBody(written ?? "");
    // 头部的作者仍是归属行里的创建者：管理员代笔不改变作者归属（否则原作者会失去后续编辑权）。
    expect(parsed.header?.author.id).toBe(CREATOR);
    expect(parsed.header?.messageId).toBe(MESSAGE_ID);
    expect(parsed.body.trimEnd()).toBe("管理员改过的正文");

    const row = harness.messageStore.rows[0];
    expect(row?.authorId).toBe(CREATOR);
    expect(row?.authorNameSnapshot).toBe(CREATOR_NAME);
    expect(row?.revision).toBe(2);
    expect(row?.lastEditorId).toBe(ADMIN);
  });

  // 指派改写的是正文里的 ticket.assignee_id 与索引列：两者必须同时落地，否则列表与详情会各说各话。
  test("指派：身份头写 ticket.assignee_id、索引落库、按负责人筛选可见", async () => {
    const { harness, creator } = await setup();

    const outcome = await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), assigneeId: OTHER },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("updated");
    const input = editInput(harness);
    expect(parseTicketBody(input.body ?? "").header?.ticket?.assigneeId).toBe(OTHER);
    // 指派不改标题与状态：这两个字段在 PATCH 里缺席。
    expect(input.title).toBeUndefined();
    expect(input.state).toBeUndefined();

    expect(harness.indexStore.rows[0]?.assigneeId).toBe(OTHER);
    const page = await harness.api.tickets.list(creator, PROJECT_A, { assigneeId: OTHER });
    expect(page.items.map((item) => item.issueNumber)).toEqual([ISSUE_NUMBER]);
    const others = await harness.api.tickets.list(creator, PROJECT_A, { assigneeId: CREATOR });
    expect(others.items).toEqual([]);
  });

  // 取消指派后身份头里不再出现 ticket 段：留着旧负责人等于这次修改没有生效。
  test("取消指派：身份头去掉 ticket 段、索引负责人清空", async () => {
    const { harness, creator } = await setup();
    harness.indexStore.seed({ projectId: PROJECT_A, issueNumber: ISSUE_NUMBER, assigneeId: OTHER });

    const outcome = await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), assigneeId: null },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("updated");
    expect(parseTicketBody(editInput(harness).body ?? "").header?.ticket).toBeUndefined();
    expect(harness.indexStore.rows[0]?.assigneeId).toBeNull();
  });

  // 关闭与重开只是 state 一个字段：远端落库后索引状态必须同批刷新，否则列表仍按 open 过滤。
  test("关闭与重开：状态落到远端并同步索引", async () => {
    const { harness, remote, creator } = await setup();

    await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), state: "closed" },
      IDEMPOTENCY_KEY,
    );
    expect(editInput(harness)).toEqual({ state: "closed" });
    expect(remote.current.state).toBe("closed");
    expect(harness.indexStore.rows[0]?.state).toBe("closed");
    expect(harness.indexStore.rows[0]?.contentVersion).toBe(versionOf(remote.current));

    await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(remote.current), state: "open" },
      "idem-key-0002",
    );
    expect(editInput(harness, 1)).toEqual({ state: "open" });
    expect(harness.indexStore.rows[0]?.state).toBe("open");
  });

  // 协议层：expectedVersion 必填、四个可改字段至少给一个；两条不满足时不进入领域层（没有版本就无处比对，
  // 而没有字段的 PATCH 只会烧掉一个幂等键）。`assigneeId: null` 是有效改动，证明 null 与缺席被区分对待。
  test("请求 schema：缺版本或没有任何改动字段被拒", async () => {
    const version = "a".repeat(64);

    expect(TicketUpdateRequestSchema.safeParse({ title: "新标题" }).success).toBe(false);
    expect(TicketUpdateRequestSchema.safeParse({ expectedVersion: version }).success).toBe(false);
    expect(TicketUpdateRequestSchema.safeParse({ expectedVersion: version, assigneeId: null }).success).toBe(true);
  });
});

describe("工单修改 — 版本与并发", () => {
  // 版本过期的判定必须在领取之前：一旦烧掉幂等键，用户重试也拿不到同一个答复。
  test("版本过期：409 且不产生账本行、不发起写入", async () => {
    const { harness, creator } = await setup();

    await expect(
      harness.api.tickets.update(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: "0".repeat(64), title: "新标题" },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(VersionConflictError);

    expect(harness.operationStore.rows).toEqual([]);
    expect(harness.git.writeCalls()).toEqual([]);
    // 只回源读过（详情 + 准入前的比较），没有发出任何写请求。
    expect(harness.git.ops("issues.get").length).toBeGreaterThan(0);
  });

  // 同一工单已有未确认变更时，另一路（不同幂等键）必须被拒：这正是「不发生静默覆盖」的防线。
  // 第一路用指派：它不进内容指纹，两路因此读到同一个 `expectedVersion`，被拒的原因只能是互斥而不是版本。
  test("未确认变更阻止后续修改：另一路 409 且远端只写一次", async () => {
    const { harness, remote, creator } = await setup();
    // 让第一路的本地终态写入失败：远端已写（202），账本停在 dispatching，构成「未确认变更」。
    harness.indexStore.failUpsert = new Error("索引写入失败");

    const first = await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), assigneeId: OTHER },
      IDEMPOTENCY_KEY,
    );
    expect(first.kind).toBe("uncertain");
    expect(harness.operationStore.rows[0]?.status).toBe("dispatching");
    expect(versionOf(remote.current)).toBe(versionOf(initialIssue()));

    await expect(
      harness.api.tickets.update(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: versionOf(initialIssue()), title: "第二路标题" },
        "idem-key-0002",
      ),
    ).rejects.toThrow(TicketChangeInFlightError);
    expect(harness.git.ops("issues.edit")).toHaveLength(1);

    // 恢复核对落成终态后，同一路修改可以正常继续（互斥只挡未确认的窗口，不永久占位）。
    harness.indexStore.failUpsert = null;
    const recovered = await harness.services.recovery.reconcile({
      organizationId: ORG_A,
      actorId: CREATOR,
      operationId: harness.operationStore.rows[0]?.id ?? "",
    });
    expect(recovered.kind).toBe("settled");
    const retried = await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(remote.current), title: "第二路标题" },
      "idem-key-0002",
    );
    expect(retried.kind).toBe("updated");
  });

  // 两路都拿着同一个旧版本时，先落地的那次改内容，后一次必须 409 而不是覆盖别人的修改。
  test("同版本两路：后一路 409 且零二次写入", async () => {
    const { harness, creator } = await setup();

    await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), title: "第一路标题" },
      IDEMPOTENCY_KEY,
    );

    await expect(
      harness.api.tickets.update(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: versionOf(initialIssue()), title: "第二路标题" },
        "idem-key-0002",
      ),
    ).rejects.toThrow(VersionConflictError);
    expect(harness.git.ops("issues.edit")).toHaveLength(1);
    expect(harness.operationStore.rows).toHaveLength(1);
  });

  // 同键同内容的重放只允许一次远端读取：重复的 POST 不能变成第二次远端写入。
  // 这里用「只指派」的请求：指派不进内容指纹，重试时 `expectedVersion` 仍然成立——若用改标题的请求，
  // 第二次会被准入前的版本闸门先拦成 409（§4.2 判定点 1，刻意排在领取之前），走不到重放分支。
  test("同幂等键重放：返回同一 operationId 且不二次出站", async () => {
    const { harness, creator } = await setup();
    const input = { expectedVersion: versionOf(initialIssue()), assigneeId: OTHER };

    const first = await harness.api.tickets.update(creator, PROJECT_A, ISSUE_NUMBER, input, IDEMPOTENCY_KEY);
    const second = await harness.api.tickets.update(creator, PROJECT_A, ISSUE_NUMBER, input, IDEMPOTENCY_KEY);

    expect(first.kind).toBe("updated");
    expect(second.kind).toBe("updated");
    expect(second.operationId).toBe(first.operationId);
    expect(harness.git.ops("issues.edit")).toHaveLength(1);
    expect(harness.operationStore.rows).toHaveLength(1);
  });

  // 未定窗口内用同一把键重试：返回同一个 operationId 的 202，绝不为了「给个结果」而重发写入。
  test("同键在未定窗口内重试：202 且零二次出站", async () => {
    const { harness, creator } = await setup();
    harness.git.behaviour.editIssue = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };
    const input = { expectedVersion: versionOf(initialIssue()), assigneeId: OTHER };

    const first = await harness.api.tickets.update(creator, PROJECT_A, ISSUE_NUMBER, input, IDEMPOTENCY_KEY);
    const second = await harness.api.tickets.update(creator, PROJECT_A, ISSUE_NUMBER, input, IDEMPOTENCY_KEY);

    expect(first).toMatchObject({ kind: "uncertain" });
    expect(second).toMatchObject({ kind: "uncertain", operationId: first.operationId });
    expect(harness.git.ops("issues.edit")).toHaveLength(1);
  });

  // 同键不同内容是调用方的 bug：必须 409 而不是「按新内容再写一次」。
  test("同键不同内容：409 IDEMPOTENCY_CONFLICT", async () => {
    const { harness, remote, creator } = await setup();

    await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), title: "第一版标题" },
      IDEMPOTENCY_KEY,
    );

    await expect(
      harness.api.tickets.update(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: versionOf(remote.current), title: "第二版标题" },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(IdempotencyConflictError);
    expect(harness.git.ops("issues.edit")).toHaveLength(1);
  });
});

describe("工单修改 — 202 的产生条件", () => {
  // 远端结果未定（超时/连接中断）：既不能报成功也不能报失败，只能 202 并让账本留在 dispatching。
  test("远端 WRITE_UNCERTAIN：202 且账本停在 dispatching", async () => {
    const { harness, creator } = await setup();
    harness.git.behaviour.editIssue = async () => {
      throw new GitError("WRITE_UNCERTAIN", "写请求超时");
    };

    const outcome = await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), title: "新标题" },
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toMatchObject({ kind: "uncertain" });
    const row = harness.operationStore.rows[0];
    expect(row?.status).toBe("uncertain");
    // 步骤回落 `dispatching`：此刻写没写还不知道，写具体步骤名会让排障误以为该步已确认。
    expect(row?.step).toBe(TICKET_OPERATION_STEP.dispatching);
    expect(harness.indexStore.rows).toEqual([]);
  });

  // 远端已确认成功、本地终态未提交（§6.2 条件 3）：响应 202，账本留在 dispatching 等恢复核对。
  // `step` 列停在 `dispatching`、已确认的那一步记在 `result.steps[]`——这与 `docs/arch/29-tickets.md`
  // 的 202 语义一致（checkpoint 只追加审计记录，不改 step 列）；合同 §6.2 的「step 停在 issue_updated」
  // 是同一事实的另一种措辞。`result.steps[]` 只供运维阅读：恢复核对读的是 `step` 列与 `expected_version`。
  test("远端已写、本地终态失败：202 且已确认步骤记在 result.steps", async () => {
    const { harness, remote, creator } = await setup();
    harness.indexStore.failUpsert = new Error("索引写入失败");

    const outcome = await harness.api.tickets.update(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), title: "新标题" },
      IDEMPOTENCY_KEY,
    );

    expect(outcome).toMatchObject({ kind: "uncertain" });
    const row = harness.operationStore.rows[0];
    expect(row?.status).toBe("dispatching");
    expect(row?.step).toBe(TICKET_OPERATION_STEP.dispatching);
    // checkpoint 的预期值可机器核对：恢复核对据此判断远端内容等不等于目标。
    const steps = (row?.result as { steps?: ReadonlyArray<{ step: string; expected: { contentVersion: string } }> })
      ?.steps;
    expect(steps?.[0]?.step).toBe(TICKET_OPERATION_STEP.issueUpdated);
    expect(steps?.[0]?.expected.contentVersion).toBe(versionOf(remote.current));
  });

  // 上游明确拒绝是确定的失败：账本写 failed 终态并抛出映射错误，不产生 202。
  test("上游确定拒绝：账本写 failed 且抛出映射后的错误", async () => {
    const { harness, creator } = await setup();
    harness.git.behaviour.editIssue = async () => {
      throw new GitError("FORBIDDEN", "当前凭据无权修改该工单", { status: 403 });
    };

    await expect(
      harness.api.tickets.update(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: versionOf(initialIssue()), title: "新标题" },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow("当前凭据无权修改该工单");
    const row = harness.operationStore.rows[0];
    expect(row?.status).toBe("failed");
    expect(row?.step).toBe(TICKET_OPERATION_STEP.upstreamFailed);
  });
});

describe("工单修改 — 归属与边界", () => {
  // 索引刷新的 author 列只能继承（归属行优先），绝不因为「这次改的是标题」就把作者写成空。
  test("索引刷新继承归属行作者：author 列不被写空", async () => {
    const { harness, admin } = await setup();
    harness.indexStore.seed({
      projectId: PROJECT_A,
      issueNumber: ISSUE_NUMBER,
      authorId: null,
      authorName: null,
      contentVersion: versionOf(initialIssue()),
    });

    await harness.api.tickets.update(
      admin,
      PROJECT_A,
      ISSUE_NUMBER,
      { expectedVersion: versionOf(initialIssue()), title: "新标题" },
      IDEMPOTENCY_KEY,
    );

    expect(harness.indexStore.rows[0]?.authorId).toBe(CREATOR);
    expect(harness.indexStore.rows[0]?.authorName).toBe(CREATOR_NAME);
  });

  // 外部来源工单（没有归属行）对普通成员一律不可改：自称作者不构成权限。
  test("外部来源工单：普通成员改标题 403 且零出站", async () => {
    const { harness, creator } = await setup({ withOwnership: false });

    await expect(
      harness.api.tickets.update(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: versionOf(initialIssue()), title: "新标题" },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow("只有工单创建者或组织管理员可以修改标题与描述");
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 跨组织项目与不存在同形返回 404：连绑定都不该打开，否则资源 ID 就成了探测面。
  test("跨组织项目：404 且 Git 零调用", async () => {
    const { harness } = await setup();
    const outsider = testActor("user_beta", ORG_B, "owner");

    await expect(
      harness.api.tickets.update(
        outsider,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: versionOf(initialIssue()), title: "新标题" },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(NotFoundError);
    expect(harness.git.calls).toEqual([]);
  });

  // 未确认变更必须跨刷新可见（裁定三.15）：详情视图的 pendingOperationId 与写路径的拒绝同谓词。
  test("详情视图暴露未确认变更的 pendingOperationId", async () => {
    const { harness, creator } = await setup();

    const clean = await harness.api.tickets.get(creator, PROJECT_A, ISSUE_NUMBER);
    expect(clean.pendingOperationId).toBeNull();

    const pending = harness.operationStore.seed({
      status: "dispatching",
      targetId: ISSUE_NUMBER,
      projectId: PROJECT_A,
    });
    const blocked = await harness.api.tickets.get(creator, PROJECT_A, ISSUE_NUMBER);
    expect(blocked.pendingOperationId).toBe(pending.id);

    // 终态不再阻止修改，视图也随之清空。
    pending.status = "succeeded";
    const settled = await harness.api.tickets.get(creator, PROJECT_A, ISSUE_NUMBER);
    expect(settled.pendingOperationId).toBeNull();
  });

  // 指派前必须现查成员关系（含已离职）：非成员写下去只会得到一个无法登录的负责人。
  test("指派非成员：400 且零远端写入、零账本行", async () => {
    const { harness, creator } = await setup();

    await expect(
      harness.api.tickets.update(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { expectedVersion: versionOf(initialIssue()), assigneeId: "user_ghost" },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(AssigneeNotMemberError);
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });
});
