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

import type { UserDisplayInfo } from "@fenix/platform-sdk";
import type { TicketIndexRow } from "../repositories/ticket-index";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import { type AuthorResolution, FALLBACK_ACTOR_NAME } from "../services/ticket-author";
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

const OPERATION_KIND_VALUES: readonly TicketOperationKind[] = ["issue.create", "project.provision"];
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

/** 详情事实（回源 + 核验后的结果）→ 详情视图。 */
export function toTicketDetailView(facts: TicketIssueFacts, displayNames: DisplayNames): TicketDetailView {
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
  };
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

/** 账本行 → 操作视图；T02 只有「建工单」与「开通项目」两种操作，取值域由视图枚举固定。 */
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
