/**
 * 工单读取路径的视图组装：索引行与领域事实 → 协议视图（backend contract §4.3）。
 *
 * 单独立文件的原因（§12.1）：协议 DTO 的组装是纯粹的投影（每个字段的来源都要能一句话说清），与 Facade
 * 承担的授权编排毫无共同点；混在一起会让「谁有权限读」和「读出来长什么样」在同一次评审里互相遮蔽。
 *
 * 三条投影口径（改动前先读）：
 * 1. **显示名优先取身份目录，回退到写入期快照**：`ticket_messages.author_name_snapshot` /
 *    `ticket_index.author_name` 是写入那一刻的名字，用户改名后不该继续显示旧名（§5.4）。身份目录缺失该
 *    id（账号已删除）时才回退快照，再缺才用兜底文案。
 * 2. **列表标签只有 ID**：索引只存 `label_ids`，名称与颜色要回源才有；T02 不为一次列表发起外部调用，因此
 *    把 ID 同时当作占位名（T04 的同步补齐真实名称与颜色）。空数组表示这条索引行确实没有标签。
 * 3. **作者 `source` 只表达「归属是否被核验」**：`external` 的来源没有可信 AOS 主体，`id` 恒为 null，前端
 *    不得据其名称做任何权限判断（判定一律在服务端）。
 */

import type { OrganizationMemberRef, UserDisplayInfo } from "@fenix/platform-sdk";
import { TICKET_OPERATION_KINDS } from "../../schemas/ticket-operation.schema";
import type { TicketIndexRow } from "../repositories/ticket-index";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import { type AuthorResolution, FALLBACK_ACTOR_NAME } from "../services/ticket-author";
import type { TicketCommentFacts } from "../services/ticket-comment-service";
import type { TicketLabelFacts } from "../services/ticket-label-service";
import type { TicketOperationKind } from "../services/ticket-operation-service";
import type { TicketIssueFacts } from "../services/ticket-service";

/** 每请求批量解析一次的展示名索引；视图组装只读它，不再逐行查库或触发外部调用。 */
export type DisplayNames = ReadonlyMap<string, UserDisplayInfo>;

export interface TicketActorView {
  /** 不可信来源时为 null（例如托管平台账号直写的工单）。 */
  readonly id: string | null;
  readonly name: string;
  readonly source: "aos" | "external";
}

export interface TicketLabelView {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
}

export interface TicketSummaryView {
  readonly issueNumber: string;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly author: TicketActorView;
  readonly assignee: TicketActorView | null;
  readonly labels: readonly TicketLabelView[];
  /** 内容指纹（§8.4）：T03 的编辑路径用它做 `expectedVersion`，T02 只读取。 */
  readonly version: string;
  readonly providerUpdatedAt: string | null;
  readonly syncedAt: string;
  readonly syncStatus: "ready" | "stale";
}

export interface TicketDetailView extends TicketSummaryView {
  /** 已剥离身份头的用户正文；不含 YAML 头部（前端不渲染协议头）。 */
  readonly body: string;
  /**
   * 本工单上未终结的修改操作 ID（`issue.update` / `issue.labels` 且状态未到终态），没有则为 `null`。
   *
   * 这是「未确认变更阻止后续修改」在**刷新后**仍然可见的唯一载体（裁定三.15）：202 与内存态都会随
   * 页面刷新消失，而服务端此刻已经在拒绝这次修改。它必须与 `begin` 的在途互斥**同谓词**，否则会出现
   * 「界面没提示、写下去却被拒」或反过来的假阻塞。
   */
  readonly pendingOperationId: string | null;
}

/**
 * 评论视图。`version` 是评论内容指纹（编辑时的 `expectedVersion`），**必须**随列表与写响应返回：
 * 前端拿不到它就只能先失败一次 409 才知道内容变了。
 */
export interface TicketCommentView {
  readonly commentId: string;
  readonly issueNumber: string;
  readonly body: string;
  readonly author: TicketActorView;
  readonly version: string;
  readonly providerUpdatedAt: string | null;
}

/** 评论列表页：`items` 内部最新在前，`nextCursor` 指向更早一页（分页机制见 `ticket-comment-page.ts`）。 */
export interface TicketCommentPageView {
  readonly items: readonly TicketCommentView[];
  readonly nextCursor: string | null;
}

/**
 * 项目标签目录项：工单视图里的标签投影再加 `description`。
 *
 * 与 {@link TicketLabelView} 分开而不是加可选字段：前者来自索引行（只有 ID 与上游回读的名称颜色），
 * 后者来自标签目录回源，多出的描述只对目录有意义；合并会让「列表里的标签为什么没有描述」变成运行期问题。
 */
export interface TicketProjectLabelView {
  readonly id: string;
  readonly name: string;
  readonly color: string | null;
  readonly description: string | null;
}

/**
 * 可指派成员投影（裁定二.6）：只有标识与姓名。
 *
 * 身份目录的其它读取路径（`searchUsers` / `listOrganizationsWithMembers`）会带出 email、手机号与账号
 * 状态；本视图刻意不声明它们，让「PII 不得从这条路由出去」在类型上就是可检查的。
 */
export interface TicketMemberView {
  readonly userId: string;
  readonly name: string;
}

export interface TicketMemberPageView {
  readonly items: readonly TicketMemberView[];
  /** 同一 `q` 下的命中总数（跨页），界面据此判断还有没有更多。 */
  readonly total: number;
}

export interface TicketListPage {
  readonly items: readonly TicketSummaryView[];
  readonly nextCursor: string | null;
}

export type TicketOperationStatus = "pending" | "dispatching" | "succeeded" | "failed" | "uncertain" | "needs_review";

export interface TicketOperationView {
  readonly operationId: string;
  readonly kind: TicketOperationKind;
  readonly status: TicketOperationStatus;
  readonly projectId: string | null;
  readonly targetId: string | null;
  readonly result: Readonly<Record<string, unknown>> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 操作类型的取值域：与协议 schema 共用同一份列表（定义处见 `schemas/ticket-operation.schema.ts`）。 */
const OPERATION_KIND_VALUES: readonly TicketOperationKind[] = TICKET_OPERATION_KINDS;
const OPERATION_STATUS_VALUES: readonly TicketOperationStatus[] = [
  "pending",
  "dispatching",
  "succeeded",
  "failed",
  "uncertain",
  "needs_review",
];

/**
 * 取值域收敛失败即抛：账本列是 `varchar`，新增取值必须与视图枚举**同批**落地，否则前端会拿到一个它
 * 不认识的 status 并按默认分支渲染（例如把「等待人工处理」显示成「成功」）。这里的失败是刻意的，
 * 它把「忘了改视图」暴露成一次明确的 500 而不是一次静默的错误展示。
 */
function requireKnown<T extends string>(value: string, allowed: readonly T[], label: string): T {
  const found = allowed.find((candidate) => candidate === value);
  if (found === undefined) throw new Error(`工单${label}取值不在视图枚举内：${value}`);
  return found;
}

/** 详情路径要批量解析展示名的 AOS 主体（作者 + 负责人），去重后交给身份目录。 */
export function collectFactsActorIds(facts: TicketIssueFacts): string[] {
  const ids = new Set<string>();
  if (facts.author.source === "aos") ids.add(facts.author.authorId);
  if (facts.assigneeId !== null) ids.add(facts.assigneeId);
  return [...ids];
}

/** 列表路径要批量解析展示名的 AOS 主体；`external` 行没有 id，不进入解析。 */
export function collectIndexActorIds(rows: readonly TicketIndexRow[]): string[] {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.authorId !== null) ids.add(row.authorId);
    if (row.assigneeId !== null) ids.add(row.assigneeId);
  }
  return [...ids];
}

/** 评论列表要批量解析展示名的 AOS 主体；一次列表只发一次身份目录查询（未通过核验的评论没有可信主体）。 */
export function collectCommentActorIds(items: readonly TicketCommentFacts[]): string[] {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.author.source === "aos") ids.add(item.author.authorId);
  }
  return [...ids];
}

/** 核验结论 → 作者视图；`aos` 的展示名取身份目录当前值，缺失时回退写入期快照。 */
function toActorView(author: AuthorResolution, displayNames: DisplayNames): TicketActorView {
  if (author.source === "external") return { id: null, name: author.authorName, source: "external" };
  return { id: author.authorId, name: displayNames.get(author.authorId)?.name ?? author.authorName, source: "aos" };
}

/** 列表行（只来自 `ticket_index`）→ 摘要视图。 */
export function toTicketSummaryView(row: TicketIndexRow, displayNames: DisplayNames): TicketSummaryView {
  return {
    issueNumber: row.issueNumber,
    title: row.title,
    state: row.state === "closed" ? "closed" : "open",
    author:
      row.authorId === null
        ? { id: null, name: row.authorName ?? FALLBACK_ACTOR_NAME, source: "external" }
        : {
            id: row.authorId,
            name: displayNames.get(row.authorId)?.name ?? row.authorName ?? FALLBACK_ACTOR_NAME,
            source: "aos",
          },
    assignee:
      row.assigneeId === null
        ? null
        : // 索引没有负责人名快照（T03 落地指派后如需展示旧名再补列），缺失时退化为 id。
          { id: row.assigneeId, name: displayNames.get(row.assigneeId)?.name ?? row.assigneeId, source: "aos" },
    labels: row.labelIds.map((labelId) => ({ id: labelId, name: labelId, color: null })),
    version: row.contentVersion,
    providerUpdatedAt: row.providerUpdatedAt?.toISOString() ?? null,
    syncedAt: row.syncedAt.toISOString(),
    syncStatus: row.syncStatus === "stale" ? "stale" : "ready",
  };
}

/**
 * 详情事实（回源 + 核验后的结果）→ 详情视图。
 *
 * `pendingOperationId` 由调用方单独查得后传入而不是由本函数去查：展示名解析与在途查询是两次无关的
 * 凭据读取，合并会让「投影」掺进 IO（也与本文件「纯投影」的定位冲突）。
 */
export function toTicketDetailView(
  facts: TicketIssueFacts,
  displayNames: DisplayNames,
  pendingOperationId: string | null,
): TicketDetailView {
  return {
    issueNumber: facts.issueNumber,
    title: facts.title,
    state: facts.state,
    author: toActorView(facts.author, displayNames),
    assignee: toAssigneeView(facts, displayNames),
    labels: facts.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    version: facts.version,
    providerUpdatedAt: facts.providerUpdatedAt,
    syncedAt: facts.syncedAt,
    syncStatus: facts.syncStatus,
    body: facts.body,
    pendingOperationId,
  };
}

/** 评论事实（已剥离身份头 + 已核验作者）→ 评论视图。 */
export function toTicketCommentView(facts: TicketCommentFacts, displayNames: DisplayNames): TicketCommentView {
  return {
    commentId: facts.commentId,
    issueNumber: facts.issueNumber,
    body: facts.body,
    author: toActorView(facts.author, displayNames),
    version: facts.version,
    providerUpdatedAt: facts.providerUpdatedAt,
  };
}

/** 标签事实（上游投影）→ 目录视图；字段同名同义，不做任何加工。 */
export function toTicketProjectLabelView(facts: TicketLabelFacts): TicketProjectLabelView {
  return { id: facts.id, name: facts.name, color: facts.color, description: facts.description };
}

/**
 * 身份目录的成员投影 → 成员视图。
 *
 * 这一层是**白名单搬运**而不是展开：只挑 `userId` 与 `name`，将来身份目录给投影加字段（例如头像）
 * 也不会自动流到 `/web` 上。改写此处必须同时评估「新字段是否属于该组织可见的公开信息」。
 */
export function toTicketMemberView(ref: OrganizationMemberRef): TicketMemberView {
  return { userId: ref.userId, name: ref.name };
}

/** 负责人视图：AOS 主体优先身份目录，外部账号（远端直写）按 `external` 呈现。 */
function toAssigneeView(facts: TicketIssueFacts, displayNames: DisplayNames): TicketActorView | null {
  if (facts.assigneeId !== null) {
    return {
      id: facts.assigneeId,
      name: displayNames.get(facts.assigneeId)?.name ?? facts.assigneeNameSnapshot ?? facts.assigneeId,
      source: "aos",
    };
  }
  if (facts.assigneeNameSnapshot !== null) {
    return { id: null, name: facts.assigneeNameSnapshot, source: "external" };
  }
  return null;
}

/** 账本行 → 操作视图；取值域由视图枚举与协议 schema 共用（新增 kind/status 必须同批，否则这里直接抛错）。 */
export function toTicketOperationView(row: TicketOperationRow): TicketOperationView {
  return {
    operationId: row.id,
    kind: requireKnown(row.kind, OPERATION_KIND_VALUES, "操作类型"),
    status: requireKnown(row.status, OPERATION_STATUS_VALUES, "操作状态"),
    projectId: row.projectId,
    targetId: row.targetId,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
