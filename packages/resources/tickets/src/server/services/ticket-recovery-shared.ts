/**
 * 恢复核对的**读原语与匹配词汇**：三个域（issue / comment / label）的判定文件共用的一组小函数。
 *
 * 放在一处的原因：`intent` 的取值口径、读失败的收敛、有界扫描与「唯一匹配」的语义必须逐字一致——
 * 每个域各写一份时，一次改动（例如 NOT_FOUND 的映射）会在另外两个域里留下不同的结论。
 *
 * 两条硬约束在类型与实现上同时成立：
 * 1. **只读远端**：可见的远端面是 {@link RecoveryRemote}（只有 `list`/`get`），写方法在类型上不可达。
 * 2. **有界**：扫描最多 {@link RECOVERY_SCAN_MAX_PAGES} 页；找不到**不判定失败**（§9.6「不得凭暂时没有
 *    认定失败」），只有「确定未落库」的判据才给出 `not_applied`。
 */

import type {
  GitComment,
  GitIssue,
  GitPage,
  GitScopedAttachmentOperations,
  GitScopedCommentOperations,
  GitScopedIssueOperations,
  GitScopedLabelOperations,
} from "@fenix/git/server";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import { GitUnavailableError } from "../errors";
import type { TicketIndexRepository } from "../repositories/ticket-index";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import { computeCommentVersion, computeContentVersion } from "./content-version";
import { classifyGitFailure } from "./git-failure";
import { hashBody, parseTicketBody, type TicketIdentityHeader } from "./identity-header";
import { RECOVERY_SCAN_MAX_PAGES } from "./ticket-limits";

/**
 * 核对阶段可达的远端面：**只有读方法**。
 *
 * 这不是注释约定而是类型约束：`create` / `edit` / `setLabels` / `labels.create` / `labels.edit` 在这里
 * 不可达，核对因此不可能重放写入（§8.4）。
 */
export interface RecoveryRemote {
  readonly issues: Pick<GitScopedIssueOperations, "list" | "get">;
  readonly comments: Pick<GitScopedCommentOperations, "list" | "get">;
  readonly labels: Pick<GitScopedLabelOperations, "list">;
  readonly attachments: Pick<GitScopedAttachmentOperations, "list">;
}

/**
 * 核对结论。
 *
 * `applied` 携带补齐本地写的 `apply`（标签类没有本地行，省略）：远端已确认写入，但本端终态未提交，
 * 因此要在这里把索引/归属行补上并把操作置为成功。
 */
export type RecoveryVerdict =
  | {
      readonly kind: "applied";
      readonly step: string;
      readonly targetId: string | null;
      readonly result: Record<string, unknown>;
      readonly intentSummary: Record<string, unknown>;
      readonly apply?: () => Promise<void>;
    }
  | { readonly kind: "not_applied" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unmatched" };

/** 操作行的 `intent` 原文（jsonb）；形状对不上时按空对象处理，让判定退化为「未找到」而不是抛错。 */
export function intentOf(row: TicketOperationRow): Record<string, unknown> {
  return isRecord(row.intent) ? row.intent : {};
}

export function intentString(row: TicketOperationRow, key: string): string | null {
  const value = intentOf(row)[key];
  return typeof value === "string" ? value : null;
}

/** 数值型 `intent` 字段（附件字节数）；非安全整数一律按缺失处理，绝不拿一个坏值去比对远端。 */
export function intentNumber(row: TicketOperationRow, key: string): number | null {
  const value = intentOf(row)[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function intentNames(row: TicketOperationRow, key: string): readonly string[] | null {
  const value = intentOf(row)[key];
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is string => typeof item === "string");
}

/** 指派是唯一「可为 null 且有值」的字段：缺席 = 不改，`null` = 取消指派（zod 区分两者）。 */
export function intentAssignee(row: TicketOperationRow): string | null | undefined {
  const value = intentOf(row);
  if (!("assigneeId" in value)) return;
  if (value.assigneeId === null) return null;
  return typeof value.assigneeId === "string" ? value.assigneeId : undefined;
}

/** `intent.since` → 列表查询参数；缺席时不带窗口（退化为从第一页开始的有界扫描）。 */
export function sinceQuery(row: TicketOperationRow): { readonly since?: string } {
  const value = intentOf(row).since;
  return typeof value === "string" && value.length > 0 ? { since: value } : {};
}

/** 补齐归属行时的作者显示名：身份目录优先（改名后取新名），其次写入期自报的名字，最后才是 id。 */
export async function resolveAuthorName(
  identity: IdentityDirectory,
  actorId: string,
  header: TicketIdentityHeader | null,
): Promise<string> {
  const display = (await identity.listUserDisplayInfo([actorId])).get(actorId);
  if (display !== undefined) return display.name;
  if (header !== null && header.author.id === actorId) return header.author.name;
  return actorId;
}

/** 读失败的统一映射：`NOT_FOUND` 交调用点（`null`），其余一律 503——读不到就不能产生任何结论。 */
function readFailure(error: unknown): Error {
  const failure = classifyGitFailure(error);
  if (failure === undefined) return error instanceof Error ? error : new Error(String(error));
  if (failure.kind === "definite" && failure.code === "RATE_LIMITED") {
    return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
  }
  return new GitUnavailableError("托管平台不可用，请稍后重试");
}

/** 单对象读取：远端明确不存在（`NOT_FOUND`）返回 `null`，其余读失败一律上抛 503。 */
export async function readOrNull<TItem>(read: () => Promise<TItem>): Promise<TItem | null> {
  try {
    return await read();
  } catch (error) {
    const failure = classifyGitFailure(error);
    if (failure?.kind === "definite" && failure.code === "NOT_FOUND") return null;
    throw readFailure(error);
  }
}

/** 有界扫描：从 `since` 起逐页读取，最多 {@link RECOVERY_SCAN_MAX_PAGES} 页（找不到就保持原状态）。 */
export async function scanPages<TItem>(
  fetch: (cursor: string | undefined) => Promise<GitPage<TItem>>,
): Promise<TItem[]> {
  const items: TItem[] = [];
  let cursor: string | undefined;
  try {
    for (let page = 0; page < RECOVERY_SCAN_MAX_PAGES; page += 1) {
      const result = await fetch(cursor);
      items.push(...result.items);
      if (result.nextCursor === null) break;
      cursor = result.nextCursor;
    }
  } catch (error) {
    throw readFailure(error);
  }
  return items;
}

/** 创建类的匹配判据（§8.3）：正文里的 `message_id` 与操作行相同**且**正文摘要与 `intent` 一致。 */
export function matchesCreated(rawBody: string, messageId: string | null, body: string | null): boolean {
  if (messageId === null || body === null) return false;
  const parsed = parseTicketBody(rawBody);
  return parsed.header?.messageId === messageId && hashBody(parsed.body) === hashBody(body);
}

/** 唯一匹配才下结论：0 条是「未找到」，多条是「多义」（同一 `message_id` 出现两次 → 人工核对）。 */
export function uniqueMatch<TItem>(matches: readonly TItem[]): TItem | "ambiguous" | "unmatched" {
  if (matches.length === 1) return matches[0] as TItem;
  return matches.length === 0 ? "unmatched" : "ambiguous";
}

/** 名称集合比较：标签是集合语义，顺序不携带信息（与 `computeContentVersion` 同口径）。 */
export function sameNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((name, index) => name === sortedRight[index]);
}

/** 索引刷新（补齐本地写的一环）：`authorship` 只由调用方从本地既有行继承，绝不写空。 */
export async function upsertIssueIndex(
  index: TicketIndexRepository,
  input: {
    readonly projectId: string;
    readonly issue: GitIssue;
    readonly version: string;
    readonly authorId: string | null;
    readonly authorName: string | null;
    readonly assigneeId: string | null;
  },
): Promise<void> {
  await index.upsertIssue({
    projectId: input.projectId,
    issueNumber: input.issue.number,
    title: input.issue.title,
    state: input.issue.state,
    authorId: input.authorId,
    authorName: input.authorName,
    assigneeId: input.assigneeId,
    labelIds: input.issue.labels.map((label) => label.id),
    contentVersion: input.version,
    providerUpdatedAt: input.issue.providerUpdatedAt === null ? null : new Date(input.issue.providerUpdatedAt),
    syncStatus: "ready",
  });
}

/** 工单内容指纹（回源口径）：标题 + 剥离身份头后的正文 + 状态 + 标签名集合（§4.2）。 */
export function issueVersion(issue: GitIssue, body: string): string {
  return computeContentVersion({
    title: issue.title,
    body,
    state: issue.state,
    labelNames: issue.labels.map((label) => label.name),
  });
}

/** 评论指纹（回源口径）：只覆盖剥离身份头后的正文。 */
export function commentVersion(comment: GitComment): string {
  return computeCommentVersion(parseTicketBody(comment.body).body);
}

/** 「远端确定未落库」的判据：回源指纹等于 `intent.expectedVersion`（§8.3）。 */
export function isUnapplied(row: TicketOperationRow, remoteVersion: string): boolean {
  const expected = row.expectedVersion;
  return expected !== null && remoteVersion === expected;
}

/** 字符串键映射（jsonb 收窄）；数组与 `null` 都不算。 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
