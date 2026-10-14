import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { GitIssue } from "@fenix/git/server";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { TicketLabelCreateRequestSchema, TicketLabelSetRequestSchema } from "../schemas/ticket-label.schema";
import { UnknownLabelError } from "../server/errors";
import { parseTicketBody } from "../server/services/identity-header";
import { describeIssue } from "../server/services/ticket-issue-write";
import { LABEL_MAX_COUNT } from "../server/services/ticket-limits";
import { TICKET_OPERATION_STEP } from "../server/services/ticket-operation-service";
import {
  BINDING_A,
  createTicketHarness,
  DATABASE_STUB,
  fixtureBody,
  GIT_LABELS,
  gitIssue,
  gitLabel,
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
 * 标签路径的契约（backend contract §12 `ticket-labels.test.ts` / §7）。
 *
 * 两条边界决定了本文件的分层：**挂载到工单**是工单更新（全量集合语义 + `expectedVersion` + 索引刷新 +
 * 工单编辑权限），而**项目标签 CRUD** 是管理员动作（无 `expectedVersion`、不碰本地索引）。把两者混在
 * 一起判定，就会出现「管理员改个标签颜色要带上工单版本」这类无意义的耦合。
 */

const CREATOR = "user_creator";
const ADMIN = "user_admin";
const OTHER = "user_other";
const ISSUE_NUMBER = "1";
const MESSAGE_ID = "msg_0001";
const BODY = "初始正文";

/** 远端工单；正文带可信身份头，因此作者归属会被核验成 AOS 主体（创建者）。 */
function initialIssue(labels: GitIssue["labels"] = []): GitIssue {
  return gitIssue({
    number: ISSUE_NUMBER,
    body: fixtureBody({ messageId: MESSAGE_ID, authorId: CREATOR, authorName: "张创建", body: BODY }),
    labels,
  });
}

/** 取第 n 次 `issues.setLabels` 的标签名集合；没有则直接失败。 */
function setLabelNames(harness: TicketHarness, index = 0): readonly string[] {
  const call = harness.git.ops("issues.setLabels")[index];
  if (call?.op !== "issues.setLabels") throw new Error(`Git 替身未记录第 ${index + 1} 次 issues.setLabels`);
  return call.labels;
}

async function setup(): Promise<{
  readonly harness: TicketHarness;
  readonly creator: ReturnType<typeof testActor>;
  readonly admin: ReturnType<typeof testActor>;
  readonly other: ReturnType<typeof testActor>;
}> {
  const members = [
    { userId: CREATOR, name: "张创建" },
    { userId: ADMIN, name: "王管理" },
    { userId: OTHER, name: "李其他" },
  ];
  stubDirectory({ users: members, membersOf: { [ORG_A]: members } });
  const harness = createTicketHarness();
  harness.projectStore.seed({ id: PROJECT_A, organizationId: ORG_A, repositoryRef: BINDING_A });
  await seedOwnership({
    messages: harness.messageStore.repository,
    objectKind: "issue",
    providerObjectId: ISSUE_NUMBER,
    messageId: MESSAGE_ID,
    authorId: CREATOR,
    authorName: "张创建",
    body: BODY,
  });
  // 标签目录与工单回显：`setLabels` 按名字回显，映射关系由写路径的 `labels.list` 先验提供。
  harness.git.behaviour.listLabels = async () => GIT_LABELS;
  let current = initialIssue();
  harness.git.behaviour.getIssue = async () => current;
  harness.git.behaviour.setLabels = async (_issueNumber, names) => {
    const byName = new Map(GIT_LABELS.map((label) => [label.name, label]));
    current = {
      ...current,
      labels: names.map((name) => byName.get(name) ?? gitLabel({ id: "0", name })),
    };
    return current;
  };
  return {
    harness,
    creator: testActor(CREATOR, ORG_A, "member"),
    admin: testActor(ADMIN, ORG_A, "owner"),
    other: testActor(OTHER, ORG_A, "member"),
  };
}

/** 当前远端内容指纹：标签名集合参与指纹，因此挂载后版本必须变。 */
function remoteVersion(issue: GitIssue): string {
  return describeIssue(issue).version;
}

beforeEach(() => {
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: DATABASE_STUB });
});

afterEach(() => {
  resetAllStubs();
});

describe("标签挂载 — 工单侧", () => {
  // 挂载是全量集合语义：`labelIds` 先映射成标签名再发 `setLabels`，索引的标签与版本同批刷新。
  test("挂载标签：ID 映射为名称、索引标签与版本刷新", async () => {
    const { harness, creator } = await setup();
    harness.indexStore.seed({
      projectId: PROJECT_A,
      issueNumber: ISSUE_NUMBER,
      authorId: CREATOR,
      authorName: "张创建",
      assigneeId: OTHER,
    });

    const outcome = await harness.api.tickets.setLabels(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { labelIds: ["1", "2"], expectedVersion: remoteVersion(initialIssue()) },
      IDEMPOTENCY_KEY,
    );

    expect(outcome.kind).toBe("updated");
    expect(setLabelNames(harness)).toEqual(["bug", "ui"]);
    const row = harness.indexStore.rows[0];
    expect(row?.labelIds).toEqual(["1", "2"]);
    expect(row?.contentVersion).toBe(remoteVersion(initialIssue(GIT_LABELS)));
    // 标签挂载不碰作者与负责人（§3.3）：只继承既有索引行。
    expect(row?.authorId).toBe(CREATOR);
    expect(row?.assigneeId).toBe(OTHER);
    expect(harness.operationStore.rows[0]?.step).toBe(TICKET_OPERATION_STEP.indexWritten);
  });

  // 空数组是「清空」而不是「不改」：两者在协议层是同一个字段的不同取值，实现必须区分。
  test("空数组表示清空标签", async () => {
    const { harness, creator } = await setup();
    harness.indexStore.seed({ projectId: PROJECT_A, issueNumber: ISSUE_NUMBER, labelIds: ["1"] });

    await harness.api.tickets.setLabels(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { labelIds: [], expectedVersion: remoteVersion(initialIssue()) },
      IDEMPOTENCY_KEY,
    );

    expect(setLabelNames(harness)).toEqual([]);
    expect(harness.indexStore.rows[0]?.labelIds).toEqual([]);
  });

  // 未知标签 ID 必须在领取之前判成 400：静默丢弃会让用户以为标签挂上了。
  test("未知标签 ID：400 且零远端写入、零账本行", async () => {
    const { harness, creator } = await setup();

    await expect(
      harness.api.tickets.setLabels(
        creator,
        PROJECT_A,
        ISSUE_NUMBER,
        { labelIds: ["1", "9"], expectedVersion: remoteVersion(initialIssue()) },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(UnknownLabelError);
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 标签数量上限是协议层的事：超过就在边界上 400，不进入领域层（否则要先领取再用一次写入换 400）。
  test("超过 LABEL_MAX_COUNT：协议层拒绝", async () => {
    const ids = Array.from({ length: LABEL_MAX_COUNT }, (_item, index) => String(index + 1));
    const version = "a".repeat(64);

    expect(TicketLabelSetRequestSchema.safeParse({ labelIds: ids, expectedVersion: version }).success).toBe(true);
    const over = TicketLabelSetRequestSchema.safeParse({
      labelIds: [...ids, String(LABEL_MAX_COUNT + 1)],
      expectedVersion: version,
    });
    expect(over.success).toBe(false);
  });

  // 挂载权限与标题/描述一致（裁定二.10）：创建者或管理员；当前负责人不因此获得权限。
  test("只有创建者与管理员能挂载：当前负责人 403 且零出站", async () => {
    const { harness, other } = await setup();
    harness.indexStore.seed({ projectId: PROJECT_A, issueNumber: ISSUE_NUMBER, assigneeId: OTHER });

    await expect(
      harness.api.tickets.setLabels(
        other,
        PROJECT_A,
        ISSUE_NUMBER,
        { labelIds: ["1"], expectedVersion: remoteVersion(initialIssue()) },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(ForbiddenError);
    expect(harness.git.writeCalls()).toEqual([]);

    // 同一份数据换管理员则放行：被拒的原因是身份而不是数据。
    const allowed = await harness.api.tickets.setLabels(
      testActor(ADMIN, ORG_A, "owner"),
      PROJECT_A,
      ISSUE_NUMBER,
      { labelIds: ["1"], expectedVersion: remoteVersion(initialIssue()) },
      "idem-key-0002",
    );
    expect(allowed.kind).toBe("updated");
  });

  // 跨组织项目与不存在同形 404，且不打开绑定。
  test("跨组织项目：404 且 Git 零调用", async () => {
    const { harness } = await setup();
    const outsider = testActor("user_beta", ORG_B, "owner");

    await expect(
      harness.api.tickets.setLabels(
        outsider,
        PROJECT_A,
        ISSUE_NUMBER,
        { labelIds: ["1"], expectedVersion: remoteVersion(initialIssue()) },
        IDEMPOTENCY_KEY,
      ),
    ).rejects.toThrow(NotFoundError);
    expect(harness.git.calls).toEqual([]);
  });
});

describe("项目标签 — 目录与管理", () => {
  // 目录直通上游，不加工也不缓存：标签的事实源在托管平台，本地没有标签表可回填。
  test("标签目录直通 labels.list", async () => {
    const { harness, creator } = await setup();

    const labels = await harness.api.labels.list(creator, PROJECT_A);

    expect(harness.git.ops("labels.list")).toHaveLength(1);
    expect(labels).toEqual([
      { id: "1", name: "bug", color: "ff0000", description: "缺陷" },
      { id: "2", name: "ui", color: "00ff00", description: null },
    ]);
  });

  // 标签 CRUD 是管理员动作：普通成员 403 且零出站（连标签目录都不读）。
  test("普通成员建改标签：403 且零出站", async () => {
    const { harness, creator } = await setup();

    await expect(harness.api.labels.create(creator, PROJECT_A, { name: "紧急" }, IDEMPOTENCY_KEY)).rejects.toThrow(
      ForbiddenError,
    );
    await expect(
      harness.api.labels.update(creator, PROJECT_A, "2", { name: "ui-new" }, "idem-key-0002"),
    ).rejects.toThrow(ForbiddenError);
    expect(harness.git.calls.filter((call) => call.op !== "createScopedClient")).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 管理员新建/改名成功：标签没有本地行可刷，成功终态就在账本（`upstream_applied`）。
  test("管理员新建与改名标签：账本写 upstream_applied", async () => {
    const { harness, admin } = await setup();
    harness.git.behaviour.createLabel = async (input) =>
      gitLabel({ id: "7", name: input.name, color: input.color ?? null });
    harness.git.behaviour.editLabel = async (labelId, input) =>
      gitLabel({ id: labelId, name: input.name ?? "ui", color: input.color ?? null });

    const created = await harness.api.labels.create(admin, PROJECT_A, { name: "紧急" }, IDEMPOTENCY_KEY);
    expect(created.kind).toBe("written");
    expect(harness.operationStore.rows[0]?.step).toBe(TICKET_OPERATION_STEP.upstreamApplied);

    const updated = await harness.api.labels.update(admin, PROJECT_A, "2", { name: "ui-new" }, "idem-key-0002");
    expect(updated.kind).toBe("written");
    expect(updated.kind === "written" ? updated.label.name : null).toBe("ui-new");
    expect(harness.operationStore.rows[1]?.step).toBe(TICKET_OPERATION_STEP.upstreamApplied);
  });

  // 不存在的标签：404 且不产生账本行（读集合的判定在领取之前）。
  test("改不存在的标签：404 且零写入", async () => {
    const { harness, admin } = await setup();

    await expect(
      harness.api.labels.update(admin, PROJECT_A, "999", { name: "ui-new" }, IDEMPOTENCY_KEY),
    ).rejects.toThrow(NotFoundError);
    expect(harness.git.writeCalls()).toEqual([]);
    expect(harness.operationStore.rows).toEqual([]);
  });

  // 改名重放：同键重试不二次出站，视图从成功终态的 `result` 还原（不重读远端）。
  test("标签改名重放：同键不二次出站", async () => {
    const { harness, admin } = await setup();
    harness.git.behaviour.editLabel = async (labelId, input) =>
      gitLabel({ id: labelId, name: input.name ?? "ui", color: input.color ?? null });

    const first = await harness.api.labels.update(admin, PROJECT_A, "2", { name: "ui-new" }, IDEMPOTENCY_KEY);
    const second = await harness.api.labels.update(admin, PROJECT_A, "2", { name: "ui-new" }, IDEMPOTENCY_KEY);

    expect(second.operationId).toBe(first.operationId);
    expect(harness.git.ops("labels.edit")).toHaveLength(1);
    expect(second.kind === "written" ? second.label.name : null).toBe("ui-new");
    expect(second.kind === "written" ? second.label.id : null).toBe("2");
  });

  // 颜色在协议层归一（带 `#` 与大小写）：领域层与上游只见到 6 位小写十六进制。
  test("颜色归一：schema 把 #ff00AA 转成 ff00aa 后传上游", async () => {
    const { harness, admin } = await setup();
    const parsed = TicketLabelCreateRequestSchema.safeParse({ name: "紧急", color: "#ff00AA" });
    expect(parsed.success).toBe(true);
    harness.git.behaviour.createLabel = async (input) =>
      gitLabel({ id: "7", name: input.name, color: input.color ?? null });

    await harness.api.labels.create(admin, PROJECT_A, parsed.success ? parsed.data : { name: "紧急" }, IDEMPOTENCY_KEY);

    const call = harness.git.ops("labels.create")[0];
    expect(call?.op === "labels.create" ? call.input.color : null).toBe("ff00aa");
  });

  // 标签名走的是正文以外的字段：挂载不会改动工单正文（否则每次打标签都会重写正文与身份头）。
  test("挂载标签不改写工单正文", async () => {
    const { harness, creator } = await setup();
    const before = initialIssue().body;

    await harness.api.tickets.setLabels(
      creator,
      PROJECT_A,
      ISSUE_NUMBER,
      { labelIds: ["1"], expectedVersion: remoteVersion(initialIssue()) },
      IDEMPOTENCY_KEY,
    );

    expect(parseTicketBody(before).header?.messageId).toBe(MESSAGE_ID);
    // 只发了标签名集合这一个动作，没有 `issues.edit`。
    expect(harness.git.ops("issues.edit")).toEqual([]);
    expect(setLabelNames(harness)).toEqual(["bug"]);
  });

  // 项目标签 CRUD 的跨组织访问与不存在同形 404：标签 ID 不得成为跨组织的存在性探测面，连绑定都不打开。
  test("项目标签 CRUD 跨组织：404 且 Git 零调用", async () => {
    const { harness } = await setup();
    const outsider = testActor("user_beta", ORG_B, "owner");

    await expect(
      harness.api.labels.update(outsider, PROJECT_A, "2", { name: "ui-new" }, IDEMPOTENCY_KEY),
    ).rejects.toThrow(NotFoundError);
    await expect(harness.api.labels.create(outsider, PROJECT_A, { name: "紧急" }, "idem-key-0002")).rejects.toThrow(
      NotFoundError,
    );
    expect(harness.git.calls).toEqual([]);
  });
});
