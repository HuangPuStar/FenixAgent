/**
 * 工单写路径（`issue.update` / `issue.labels`）的共用读写件。
 *
 * 从 `ticket-edit-service.ts` 提取（backend contract §0.1 的 380 行预算）：两条写路径共享的不是「相似代码」
 * 而是一套口径——回源读失败怎么映射、内容指纹怎么算、索引刷新怎么继承作者。口径散在两条路径里，改一处就会
 * 让「标题改完了但指派没生效」这类部分成功出现两种记账。
 *
 * 三条不可动摇的口径：
 * 1. **内容指纹一律从回源内容算**（`describeIssue`），绝不读 `ticket_index.content_version` 比较：管理端
 *    直改会让索引落后于远端，用索引比较会造成持续性的伪冲突（§4.2）。
 * 2. **索引刷新的作者列只从既有行继承**（`finalizeIssueWrite` 的 `authorship`）：本地收尾绝不把
 *    `author_id` / `author_name` 写空，否则列表里这条工单的作者会凭空消失（T04 同步同受此约束）。
 * 3. **回源读失败不是写失败**（`readIssueForWrite`）：读故障不改账本状态，交恢复核对；只有 NOT_FOUND 与
 *    限流有独立的对外映射，其余一律 503。
 */

import type { GitIssue, GitScopedClient } from "@fenix/git/server";
import type { AppError } from "@fenix/platform-sdk";
import { ConflictError, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { GitUnavailableError } from "../errors";
import type { TicketIndexRepository, TicketIndexRow } from "../repositories/ticket-index";
import type { TicketMessageRow } from "../repositories/ticket-messages";
import { computeContentVersion } from "./content-version";
import { classifyGitFailure, type GitFailureKind } from "./git-failure";
import { parseTicketBody } from "./identity-header";
import { resolveTicketAuthor } from "./ticket-author";
import type { TicketOperationService } from "./ticket-operation-service";
import type { TicketIssueFacts } from "./ticket-service";

/** 回源工单的领域要点：剥离身份头后的正文、标签名集合与内容指纹（`assignee_id` 不进指纹）。 */
export interface TicketIssueDescription {
  readonly body: string;
  readonly labelNames: readonly string[];
  readonly version: string;
}

/** 回源读取；读失败按「确定失败」映射，**不改账本状态**（读故障不是写故障，交恢复核对）。 */
export async function readIssueForWrite(client: GitScopedClient, issueNumber: string): Promise<GitIssue> {
  try {
    return await client.issues.get(issueNumber);
  } catch (error) {
    const failure = classifyGitFailure(error);
    if (failure === undefined) throw error;
    if (failure.kind === "definite" && failure.code === "NOT_FOUND") throw new NotFoundError("工单不存在");
    if (failure.kind === "definite" && failure.code === "RATE_LIMITED") {
      throw new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
    }
    throw new GitUnavailableError("托管平台不可用，请稍后重试");
  }
}

/** 回源工单的领域要点；身份头里的 `message_id`、`assignee_id` 变化不制造伪冲突（§4.2）。 */
export function describeIssue(issue: GitIssue): TicketIssueDescription {
  const parsed = parseTicketBody(issue.body);
  const labelNames = issue.labels.map((label) => label.name);
  return {
    body: parsed.body,
    labelNames,
    version: computeContentVersion({ title: issue.title, body: parsed.body, state: issue.state, labelNames }),
  };
}

/** 写失败的对外映射；同一个 Git 码在工单创建与修改路径上都指向「这次修改没成」。 */
export function toIssueWriteError(failure: Extract<GitFailureKind, { kind: "definite" }>): AppError {
  if (failure.code === "NOT_FOUND") return new NotFoundError("工单不存在");
  if (failure.code === "FORBIDDEN") return new ForbiddenError("当前凭据无权修改该工单");
  if (failure.code === "RATE_LIMITED") return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
  if (failure.code === "CONFLICT") return new ConflictError("上游拒绝了本次修改：目标内容已被他人变更");
  return new GitUnavailableError("托管平台不可用，请稍后重试");
}

/** 远端回显 + 本端归属行/索引行 → 领域事实；视图组装（含身份展示名）归 Facade。 */
export function assembleIssueFacts(input: {
  readonly organizationId: string;
  readonly issue: GitIssue;
  readonly indexRow: TicketIndexRow | undefined;
  readonly message: TicketMessageRow | undefined;
}): TicketIssueFacts {
  const described = describeIssue(input.issue);
  const indexRow = input.indexRow;
  return {
    issueNumber: input.issue.number,
    title: input.issue.title,
    state: input.issue.state,
    labels: input.issue.labels.map((label) => ({ id: label.id, name: label.name, color: label.color })),
    body: described.body,
    version: described.version,
    providerUpdatedAt: input.issue.providerUpdatedAt,
    syncedAt: indexRow?.syncedAt.toISOString() ?? new Date().toISOString(),
    syncStatus: indexRow === undefined || indexRow.syncStatus === "stale" ? "stale" : "ready",
    author: resolveTicketAuthor({
      organizationId: input.organizationId,
      providerObjectId: input.issue.number,
      rawBody: input.issue.body,
      fallbackActor: input.issue.author,
      message: input.message,
    }),
    assigneeId: indexRow?.assigneeId ?? null,
    // 负责人是外部账号（远端直写）时本地没有 AOS id，展示名取远端账号；有 AOS 负责人时不由远端冒充。
    assigneeNameSnapshot:
      indexRow?.assigneeId === undefined || indexRow.assigneeId === null ? (input.issue.assignee?.name ?? null) : null,
  };
}

/** 本地收尾的输入；`expected` 由调用方在远端写入成功后作为 checkpoint 单独提交（不随本地事务回滚）。 */
export interface FinalizeIssueWriteInput {
  readonly operationId: string;
  readonly projectId: string;
  readonly issue: GitIssue;
  readonly version: string;
  readonly step: string;
  readonly authorship: {
    readonly authorId: string | null;
    readonly authorName: string | null;
    readonly assigneeId: string | null;
  };
  readonly intentSummary: Record<string, unknown>;
}

/**
 * 索引刷新 + 成功终态（调用方保证在同一事务内调用）。
 *
 * `succeed` 与索引写入同事务：两者要么全成要么全不成。本地事务失败时账本保持 `dispatching`、`step` 停在
 * 远端那一步（checkpoint 已在事务外提交），响应转 202 由恢复核对补齐（§6.2 条件 3）。
 */
export async function finalizeIssueWrite(
  deps: { readonly operations: TicketOperationService; readonly index: TicketIndexRepository },
  input: FinalizeIssueWriteInput,
): Promise<TicketIndexRow> {
  const written = await deps.index.upsertIssue({
    projectId: input.projectId,
    issueNumber: input.issue.number,
    title: input.issue.title,
    state: input.issue.state,
    ...input.authorship,
    syncStatus: "ready",
    labelIds: input.issue.labels.map((label) => label.id),
    contentVersion: input.version,
    providerUpdatedAt: input.issue.providerUpdatedAt === null ? null : new Date(input.issue.providerUpdatedAt),
  });
  await deps.operations.succeed({
    operationId: input.operationId,
    step: input.step,
    targetId: input.issue.number,
    result: { issueNumber: input.issue.number, version: input.version },
    intentSummary: input.intentSummary,
  });
  return written;
}
