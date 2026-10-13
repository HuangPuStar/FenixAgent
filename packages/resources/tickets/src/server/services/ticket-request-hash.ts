/**
 * 幂等请求指纹：同一个 `Idempotency-Key` 是否被用于**同一份请求内容**的唯一判据（§8.2 步骤 1）。
 *
 * 指纹覆盖「版本前缀 + 操作类型 + 目标路径 + 规范化请求体」四段，缺任何一段都会放出一类串味：
 * 少了 `kind`，同键跨路由（建工单 vs 开通项目）会被当成重放；少了目标路径，同键在不同项目下会被
 * 当成同一个操作；少了前缀，口径升级后新旧指纹会被误判为相同。
 *
 * 请求体先**规范化**再入摘要：`{"title":"a","body":"b"}` 与 `{"body":"b","title":"a"}` 是同一份请求，
 * 键序不该产生 409。T03 会在请求体里加 `expectedVersion` 等字段，届时沿用同一套规范化即可。
 *
 * 与 `content-version.ts` 的关系：两者都用数组避免键序分歧、都用 sha256 十六进制，但**不共用**函数——
 * 内容指纹描述的是远端对象的当前内容，请求指纹描述的是「这一次请求是什么」，混用会让任何一次
 * 口径调整同时改变两处语义。
 */

import { createHash } from "node:crypto";
import type { TicketOperationKind } from "./ticket-operation-service";

/** 指纹口径的版本前缀；增删参与字段时必须改它。 */
export const TICKET_REQUEST_HASH_PREFIX = "fenix.tickets.v1";

/** 建工单的目标路径（写进指纹，不是真实请求地址；项目维度必须参与，否则同键的跨项目请求会被误判重放）。 */
export function issueCreateTargetPath(projectId: string): string {
  return `/web/tickets/${projectId}`;
}

/** 开通默认项目的目标路径；开通不区分项目（此刻项目还没建出来），一条路径即可。 */
export function projectProvisionTargetPath(): string {
  return "/web/ticket-projects/default";
}

/** 修改工单（标题/描述/负责人/状态）的目标路径。 */
export function issueUpdateTargetPath(projectId: string, issueNumber: string): string {
  return `/web/tickets/${projectId}/${issueNumber}`;
}

/** 全量设置工单标签集合的目标路径（与工单本体分开：同键的两类请求不得互相判成重放）。 */
export function issueLabelsTargetPath(projectId: string, issueNumber: string): string {
  return `/web/tickets/${projectId}/${issueNumber}/labels`;
}

/** 创建评论的目标路径。 */
export function commentCreateTargetPath(projectId: string, issueNumber: string): string {
  return `/web/tickets/${projectId}/${issueNumber}/comments`;
}

/** 修改评论的目标路径；`commentId` 参与，避免同键在不同评论上被判成重放。 */
export function commentUpdateTargetPath(projectId: string, issueNumber: string, commentId: string): string {
  return `/web/tickets/${projectId}/${issueNumber}/comments/${commentId}`;
}

/**
 * 上传附件的目标路径。
 *
 * 附件挂在**工单**上（上游的附件端点以 Issue 为坐标），因此路径到工单为止：同一工单的两次上传靠
 * `payload` 里的文件名与内容摘要区分，不同工单则天然不同路径。
 */
export function attachmentUploadTargetPath(projectId: string, issueNumber: string): string {
  return `/web/tickets/${projectId}/${issueNumber}/attachments`;
}

/** 新建项目标签的目标路径。 */
export function labelCreateTargetPath(projectId: string): string {
  return `/web/ticket-projects/${projectId}/labels`;
}

/** 修改项目标签的目标路径。 */
export function labelUpdateTargetPath(projectId: string, labelId: string): string {
  return `/web/ticket-projects/${projectId}/labels/${labelId}`;
}

/**
 * 计算请求指纹。
 *
 * `payload` 传**请求的领域输入**（建工单是 `{title, body}`，开通项目是 `{connectionId, mode, repository}`），
 * 不传已序列化好的字符串：调用方各自 `JSON.stringify` 会把键序问题重新引进来。
 */
export function hashTicketRequest(input: {
  readonly kind: TicketOperationKind;
  readonly targetPath: string;
  readonly payload: unknown;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([TICKET_REQUEST_HASH_PREFIX, input.kind, input.targetPath, canonicalize(input.payload)]))
    .digest("hex");
}

/** 规范化：对象键按字典序递归重排，数组保持原序（顺序可能是语义的一部分，例如标签列表）。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!isPlainRecord(value)) return value;
  const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
}

/** 收窄到字符串键的普通对象（数组与 null 已在上面排除）。 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
