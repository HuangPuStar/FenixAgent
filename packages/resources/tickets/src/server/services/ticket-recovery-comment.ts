/**
 * 恢复核对的评论域判定：`comment.create` / `comment.update`（backend contract §8.3）。
 *
 * 两条与工单域不同的坐标事实：
 * - 创建：`targetId` 在领取时是工单号（`intent.issueNumber` 兜底），核对命中后**改为评论 ID** —— 之后的重放
 *   按评论读回，归属行也以评论 ID 为 `providerObjectId`。
 * - 修改：`targetId` 就是评论 ID，`intent.body` 是改写目标，`expectedVersion` 是改写前版本。
 *
 * 本地补齐只写归属行（`ticket_messages`）与 `revision`，不刷新工单索引：改评论不改工单内容指纹
 * （`issue.update` 的 `lastEditorId` 语义同源于裁定二.8「只记正文改写者」）。
 */

import type { GitComment } from "@fenix/git/server";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import type { TicketMessageRepository } from "../repositories/ticket-messages";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import { computeCommentVersion } from "./content-version";
import { hashBody, parseTicketBody } from "./identity-header";
import { RECOVERY_SCAN_PAGE_LIMIT } from "./ticket-limits";
import { TICKET_OPERATION_STEP } from "./ticket-operation-service";
import {
  commentVersion,
  intentString,
  isUnapplied,
  matchesCreated,
  type RecoveryRemote,
  type RecoveryVerdict,
  readOrNull,
  resolveAuthorName,
  scanPages,
  sinceQuery,
  uniqueMatch,
} from "./ticket-recovery-shared";

/** 评论域判定需要的本地仓储：只用到归属行（索引不参与评论核对）。 */
export interface RecoveryCommentContext {
  readonly messages: TicketMessageRepository;
  readonly identity: IdentityDirectory;
}

/** `comment.create`：在已知工单号上按 `since` 有界翻页，用「`message_id` + 摘要」唯一命中那条评论。 */
export async function inspectCommentCreate(
  ctx: RecoveryCommentContext,
  row: TicketOperationRow,
  projectId: string,
  remote: RecoveryRemote,
): Promise<RecoveryVerdict> {
  const issueNumber = intentString(row, "issueNumber") ?? row.targetId;
  if (issueNumber === null || row.messageId === null) return { kind: "ambiguous" };
  const candidates = await scanPages((cursor) =>
    remote.comments.list(issueNumber, {
      limit: RECOVERY_SCAN_PAGE_LIMIT,
      ...sinceQuery(row),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const matched = uniqueMatch(
    candidates.filter((comment) => matchesCreated(comment.body, row.messageId, intentString(row, "body"))),
  );
  if (matched === "ambiguous" || matched === "unmatched") return { kind: matched };

  const comment = matched;
  return {
    kind: "applied",
    step: TICKET_OPERATION_STEP.ownershipWritten,
    targetId: comment.id,
    result: { commentId: comment.id, issueNumber: comment.issueNumber, version: commentVersion(comment) },
    intentSummary: { bodyHash: hashBody(parseTicketBody(comment.body).body), issueNumber: comment.issueNumber },
    apply: async () => {
      await supplementOwnership(ctx, row, projectId, comment, null);
    },
  };
}

/** `comment.update`：回源单条评论比较正文指纹；已改写则 `revision + 1`，无归属行则新落一行。 */
export async function inspectCommentUpdate(
  ctx: RecoveryCommentContext,
  row: TicketOperationRow,
  projectId: string,
  remote: RecoveryRemote,
): Promise<RecoveryVerdict> {
  const commentId = intentString(row, "commentId") ?? row.targetId;
  if (commentId === null) return { kind: "unmatched" };
  const comment = await readOrNull(() => remote.comments.get(commentId));
  if (comment === null) return { kind: "unmatched" };

  const remoteVersion = commentVersion(comment);
  const targetBody = intentString(row, "body");
  if (targetBody === null || remoteVersion !== computeCommentVersion(targetBody)) {
    return isUnapplied(row, remoteVersion) ? { kind: "not_applied" } : { kind: "unmatched" };
  }
  const parsed = parseTicketBody(comment.body);
  const existing = await ctx.messages.findObjectMessage({
    projectId,
    objectKind: "comment",
    providerObjectId: comment.id,
  });
  const messageId = parsed.header?.messageId ?? row.messageId;
  if (existing === undefined && messageId === null) return { kind: "ambiguous" };
  const authorName = existing === undefined ? await resolveAuthorName(ctx.identity, row.actorId, parsed.header) : null;
  return {
    kind: "applied",
    step: TICKET_OPERATION_STEP.ownershipWritten,
    targetId: comment.id,
    result: { commentId: comment.id, issueNumber: comment.issueNumber, version: remoteVersion },
    intentSummary: { bodyHash: hashBody(parsed.body), issueNumber: comment.issueNumber },
    apply: async () => {
      // 远端已改写：有归属行就 `revision + 1` 并记改写者，没有则新落一行（外部评论被管理员编辑）。
      const current = await ctx.messages.findObjectMessage({
        projectId,
        objectKind: "comment",
        providerObjectId: comment.id,
      });
      if (current !== undefined) {
        await ctx.messages.updateRevision({
          id: current.id,
          bodyHash: hashBody(parsed.body),
          lastEditorId: row.actorId,
        });
        return;
      }
      await supplementOwnership(ctx, row, projectId, comment, authorName ?? row.actorId);
    },
  };
}

/** 评论的归属行补齐：远端已有这条评论，本地只补「谁写的」这一行（已存在则不动，不覆盖既有作者）。 */
async function supplementOwnership(
  ctx: RecoveryCommentContext,
  row: TicketOperationRow,
  projectId: string,
  comment: GitComment,
  authorName: string | null,
): Promise<void> {
  const existing = await ctx.messages.findObjectMessage({
    projectId,
    objectKind: "comment",
    providerObjectId: comment.id,
  });
  if (existing !== undefined) return;
  const parsed = parseTicketBody(comment.body);
  await ctx.messages.insert({
    projectId,
    objectKind: "comment",
    providerObjectId: comment.id,
    messageId: parsed.header?.messageId ?? row.messageId ?? "",
    authorId: row.actorId,
    authorNameSnapshot: authorName ?? (await resolveAuthorName(ctx.identity, row.actorId, parsed.header)),
    bodyHash: hashBody(parsed.body),
    revision: 1,
  });
}
