/**
 * 评论领域服务：列表（倒序分页 + 作者核验）、创建、修改（backend contract §3.2 / §4.4 / §6.1）。
 *
 * 三条口径与工单侧同源，不得各自实现：
 * 1. **作者核验复用 `resolveTicketAuthor`**：身份头、归属行、正文摘要、组织四处同时吻合才算 AOS 作者；
 *    任何一处对不上都退化为 `external` 且 `authorId === null`——外部来源评论因此对非管理员一律不可编辑
 *    （§3.2），这正是「不能按其自填 user_id 授予编辑权」的落点。
 * 2. **两次版本比较都以回源结果为准**（§4.2）：准入前一次（不一致直接 409，不产生账本行），领取后一次
 *    （两次之间落地的他人写入只有这里看得到）。
 * 3. **倒序分页**：适配器按创建时间升序返回，而评论区要「首屏 = 最新一页」（方案 §12 的万级评论门槛）。
 *    机制：首屏先用一页请求探出 `Link` 头的末页页码（`GitPage.lastCursor`），再直接取末页，因此**不**全量
 *    扫描；`nextCursor` 是「更早一页的页码」，逐页递减到 1 为止。上游未透出末页时退化为单页（见
 *    `listDescendingPage` 的注释），绝不用「首屏最旧」冒充最新。
 */

import { randomUUID } from "node:crypto";
import type { GitComment, GitScopedClient, GitService } from "@fenix/git/server";
import type { AppError } from "@fenix/platform-sdk";
import { ConflictError, ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import {
  appErrorFromOperationResult,
  GitUnavailableError,
  toOperationFailureResult,
  VersionConflictError,
} from "../errors";
import { ticketsIssueLockKey } from "../repositories/advisory-lock";
import type { TicketMessageRepository, TicketMessageRow } from "../repositories/ticket-messages";
import { computeCommentVersion } from "./content-version";
import { classifyGitFailure, type GitFailureKind } from "./git-failure";
import { buildTicketBody, hashBody, parseTicketBody } from "./identity-header";
import { type AuthorResolution, resolveTicketAuthor } from "./ticket-author";
import { listDescendingPage } from "./ticket-comment-page";
import { connectTicketGitClient } from "./ticket-git-client";
import { RECOVERY_SINCE_SKEW_MS } from "./ticket-limits";
import type { TicketOperationAdmission, TicketOperationService } from "./ticket-operation-service";
import { COMMENT_CHANGE_KINDS, TICKET_OPERATION_STEP } from "./ticket-operation-service";
import { commentCreateTargetPath, commentUpdateTargetPath, hashTicketRequest } from "./ticket-request-hash";
import { localWriteFailed, settleTicketWriteFailure } from "./ticket-write-failure";

/** 评论的领域事实（已剥离身份头）；视图组装与展示名解析归 Facade。 */
export interface TicketCommentFacts {
  readonly commentId: string;
  readonly issueNumber: string;
  /** 已剥离身份头的用户正文。 */
  readonly body: string;
  readonly author: AuthorResolution;
  /** 评论内容指纹：编辑时的 `expectedVersion`，只覆盖剥离身份头后的正文（§4.4）。 */
  readonly version: string;
  readonly providerUpdatedAt: string | null;
}

export interface TicketCommentPage {
  readonly items: readonly TicketCommentFacts[];
  /** 更早一页的页码；`null` 表示已经到底（没有更早的评论）。 */
  readonly nextCursor: string | null;
}

export type TicketCommentWriteOutcome =
  | { readonly kind: "written"; readonly operationId: string; readonly facts: TicketCommentFacts }
  | { readonly kind: "uncertain"; readonly operationId: string };

/** 三个坐标都由 Facade 从已授权的项目行传入，绝不取自请求体。 */
export interface TicketCommentScope {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly issueNumber: string;
}

export interface TicketCommentService {
  /** 单条评论的领域事实；评论不存在或不属于该工单 → 404（同形，不给探测面）。 */
  getComment(input: TicketCommentScope & { readonly commentId: string }): Promise<TicketCommentFacts>;
  listPage(
    input: TicketCommentScope & { readonly limit: number; readonly cursor?: string },
  ): Promise<TicketCommentPage>;
  createComment(
    input: TicketCommentScope & {
      readonly actorId: string;
      readonly actorName: string;
      readonly body: string;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketCommentWriteOutcome>;
  updateComment(
    input: TicketCommentScope & {
      readonly commentId: string;
      readonly actorId: string;
      readonly actorName: string;
      readonly body: string;
      readonly expectedVersion: string;
      readonly idempotencyKey: string;
    },
  ): Promise<TicketCommentWriteOutcome>;
}

export interface TicketCommentServiceDeps {
  readonly messages: TicketMessageRepository;
  readonly operations: TicketOperationService;
  readonly git: GitService;
}

export function createTicketCommentService(deps: TicketCommentServiceDeps): TicketCommentService {
  const { messages, operations, git } = deps;

  /** 评论的领域事实：正文、作者核验结论与内容指纹一次算出（复用 T02 的核验口径，一处不抄第二遍）。 */
  function toCommentFacts(
    organizationId: string,
    comment: GitComment,
    message: TicketMessageRow | undefined,
  ): TicketCommentFacts {
    const parsed = parseTicketBody(comment.body);
    return {
      commentId: comment.id,
      issueNumber: comment.issueNumber,
      body: parsed.body,
      author: resolveTicketAuthor({
        organizationId,
        providerObjectId: comment.id,
        rawBody: comment.body,
        fallbackActor: comment.author,
        message,
      }),
      version: computeCommentVersion(parsed.body),
      providerUpdatedAt: comment.providerUpdatedAt,
    };
  }

  /** 读单条评论：`NOT_FOUND` 是有结论的 404，其余上游故障一律 503（不伪装成「评论不存在」）。 */
  async function readComment(client: GitScopedClient, commentId: string): Promise<GitComment> {
    try {
      return await client.comments.get(commentId);
    } catch (error) {
      const failure = classifyGitFailure(error);
      if (failure === undefined) throw error;
      if (failure.kind === "definite" && failure.code === "NOT_FOUND") throw new NotFoundError("评论不存在");
      // 读路径没有「写入未定」一说：`WRITE_UNCERTAIN` 只会出现在写方法上，这里与其余故障同为 503。
      if (failure.kind === "definite") throw toCommentWriteError(failure, "update");
      throw new GitUnavailableError("托管平台不可用，请稍后重试");
    }
  }

  /** 写失败的对外映射：同一个 Git 码在创建与修改路径上的语义不同，因此按动作分开给消息。 */
  function toCommentWriteError(
    failure: Extract<GitFailureKind, { kind: "definite" }>,
    action: "create" | "update",
  ): AppError {
    if (failure.code === "NOT_FOUND") {
      return new NotFoundError(action === "create" ? "工单不存在" : "评论不存在或已被删除");
    }
    if (failure.code === "FORBIDDEN") {
      return new ForbiddenError(action === "create" ? "当前凭据无权发表评论" : "当前凭据无权修改该评论");
    }
    if (failure.code === "RATE_LIMITED") {
      return new GitUnavailableError("托管平台限流，请稍后重试", "GIT_RATE_LIMITED");
    }
    if (failure.code === "CONFLICT") return new ConflictError("上游拒绝了本次修改：内容已被他人变更");
    return new GitUnavailableError("托管平台不可用，请稍后重试");
  }

  /**
   * 取一页评论，**按时间倒序**返回；`nextCursor` 是更早一页的页码（机制与退化点见 `ticket-comment-page.ts`）。
   */
  async function readPage(input: TicketCommentScope & { readonly limit: number; readonly cursor?: string }) {
    const client = await connectTicketGitClient(git, input);
    const page = await listDescendingPage(client, input.issueNumber, input.limit, input.cursor);

    // 一次解析 + 一次批量归属查询：N 条评论只产生 1 次本地查询（§3.2）。
    const parsed = page.items.map((comment) => parseTicketBody(comment.body));
    const messageIds = parsed
      .map((item) => item.header?.messageId)
      .filter((messageId): messageId is string => messageId !== undefined);
    const rows = await messages.findManyByMessageIds({ projectId: input.projectId, messageIds });
    const byMessageId = new Map(rows.map((row) => [row.messageId, row]));

    return {
      items: page.items.map((comment, index) => {
        const header = parsed[index]?.header ?? null;
        return toCommentFacts(
          input.organizationId,
          comment,
          header === null ? undefined : byMessageId.get(header.messageId),
        );
      }),
      nextCursor: page.nextCursor,
    };
  }

  /** 重放已成功的创建：允许一次远端读取拼视图（§5.4），**绝不**重放写入。 */
  async function replayCreatedComment(
    input: { readonly organizationId: string; readonly projectId: string },
    admission: Extract<TicketOperationAdmission, { kind: "replayed" }>,
    client: GitScopedClient,
  ): Promise<TicketCommentWriteOutcome> {
    const commentId = admission.targetId;
    if (commentId === null) throw new Error("评论创建操作已成功，但结果缺少评论坐标");
    const comment = await readComment(client, commentId);
    const message = await messages.findObjectMessage({
      projectId: input.projectId,
      objectKind: "comment",
      providerObjectId: comment.id,
    });
    return {
      kind: "written",
      operationId: admission.operationId,
      facts: toCommentFacts(input.organizationId, comment, message),
    };
  }

  return {
    async getComment(input) {
      const client = await connectTicketGitClient(git, input);
      const comment = await readComment(client, input.commentId);
      // 评论不属于该工单 → 404（方案 §8「服务端核验评论确属该 Issue」），与「评论不存在」同形。
      if (comment.issueNumber !== input.issueNumber) throw new NotFoundError("评论不属于该工单");
      const message = await messages.findObjectMessage({
        projectId: input.projectId,
        objectKind: "comment",
        providerObjectId: comment.id,
      });
      return toCommentFacts(input.organizationId, comment, message);
    },

    async listPage(input) {
      return await readPage(input);
    },

    async createComment(input) {
      const generatedMessageId = `msg_${randomUUID()}`;
      const admission = await operations.begin({
        organizationId: input.organizationId,
        actorId: input.actorId,
        kind: "comment.create",
        projectId: input.projectId,
        // 评论创建**不进互斥组**（两个成员同时评论不是冲突，§5.5）；坐标仍写工单号，恢复核对据此定位。
        targetId: input.issueNumber,
        lockKey: ticketsIssueLockKey(input.projectId, input.issueNumber),
        idempotencyKey: input.idempotencyKey,
        requestHash: hashTicketRequest({
          kind: "comment.create",
          targetPath: commentCreateTargetPath(input.projectId, input.issueNumber),
          payload: { body: input.body },
        }),
        messageId: generatedMessageId,
        expectedVersion: null,
        intent: { body: input.body, issueNumber: input.issueNumber, since: sinceForRecovery() },
        step: TICKET_OPERATION_STEP.dispatching,
      });
      if (admission.kind === "failed") throw appErrorFromOperationResult(admission.result);
      if (admission.kind === "in_flight") return { kind: "uncertain", operationId: admission.operationId };

      let client: GitScopedClient;
      try {
        client = await connectTicketGitClient(git, input);
      } catch (error) {
        // 绑定不可用是**确定**失败（T02 `issue.create` 同口径）：写终态后抛出，同键重放还原同一个 503。
        if (error instanceof GitUnavailableError) {
          await operations.fail({
            operationId: admission.operationId,
            step: TICKET_OPERATION_STEP.upstreamFailed,
            result: toOperationFailureResult(error),
          });
        }
        throw error;
      }
      if (admission.kind === "replayed") return await replayCreatedComment(input, admission, client);

      // 既有 `pending` 行保留着上一执行者写入的 message_id：必须沿用，否则远端正文的头与本端账本对不上。
      const operationId = admission.operationId;
      const messageId = admission.messageId ?? generatedMessageId;
      let created: GitComment;
      try {
        created = await client.comments.create(input.issueNumber, {
          body: buildTicketBody({
            header: {
              schema: 1,
              organizationId: input.organizationId,
              messageId,
              author: { id: input.actorId, name: input.actorName },
            },
            body: input.body,
          }),
        });
      } catch (error) {
        await settleTicketWriteFailure({
          operations,
          operationId,
          error,
          toError: (failure) => toCommentWriteError(failure, "create"),
        });
        return { kind: "uncertain", operationId };
      }

      const version = computeCommentVersion(parseTicketBody(created.body).body);
      try {
        // 远端那一步先独立落账（`step` 在本地事务失败时停在 `comment_created`，§6.2 条件 3）。
        await operations.checkpoint({
          operationId,
          step: TICKET_OPERATION_STEP.commentCreated,
          expected: { commentId: created.id, issueNumber: created.issueNumber, contentVersion: version },
        });
        await runInTransaction(async () => {
          await messages.insert({
            projectId: input.projectId,
            objectKind: "comment",
            providerObjectId: created.id,
            messageId,
            authorId: input.actorId,
            authorNameSnapshot: input.actorName,
            bodyHash: hashBody(parseTicketBody(created.body).body),
            revision: 1,
          });
          await operations.succeed({
            operationId,
            step: TICKET_OPERATION_STEP.ownershipWritten,
            // 终态坐标换成**创建出来的评论**：恢复核对与重放都要按它读回同一条评论（§8.3）。
            targetId: created.id,
            result: { commentId: created.id, issueNumber: created.issueNumber, version },
            intentSummary: { bodyHash: hashBody(parseTicketBody(created.body).body), issueNumber: created.issueNumber },
          });
        });
      } catch (error) {
        return localWriteFailed({
          operationId,
          projectId: input.projectId,
          targetId: created.id,
          targetKind: "comment",
          error,
        });
      }

      return {
        kind: "written",
        operationId,
        facts: toCommentFacts(input.organizationId, created, undefined),
      };
    },

    async updateComment(input) {
      const client = await connectTicketGitClient(git, input);
      // 准入前：核验评论确属该工单 + 首次版本比较；两者都在领取之前，不产生账本行（§4.2 判定点 1）。
      const current = await readComment(client, input.commentId);
      if (current.issueNumber !== input.issueNumber) throw new NotFoundError("评论不属于该工单");
      if (computeCommentVersion(parseTicketBody(current.body).body) !== input.expectedVersion) {
        throw new VersionConflictError();
      }

      const admission = await operations.begin({
        organizationId: input.organizationId,
        actorId: input.actorId,
        kind: "comment.update",
        projectId: input.projectId,
        targetId: input.commentId,
        lockKey: ticketsIssueLockKey(input.projectId, input.issueNumber),
        guardKinds: COMMENT_CHANGE_KINDS,
        idempotencyKey: input.idempotencyKey,
        requestHash: hashTicketRequest({
          kind: "comment.update",
          targetPath: commentUpdateTargetPath(input.projectId, input.issueNumber, input.commentId),
          payload: { body: input.body, expectedVersion: input.expectedVersion },
        }),
        messageId: `msg_${randomUUID()}`,
        expectedVersion: input.expectedVersion,
        intent: {
          body: input.body,
          issueNumber: input.issueNumber,
          commentId: input.commentId,
          since: sinceForRecovery(),
        },
        step: TICKET_OPERATION_STEP.dispatching,
      });
      if (admission.kind === "failed") throw appErrorFromOperationResult(admission.result);
      if (admission.kind === "in_flight") return { kind: "uncertain", operationId: admission.operationId };
      if (admission.kind === "replayed") return await replayCreatedComment(input, admission, client);

      // 第二次比较（§4.2 判定点 2）：只有领取后的回源才看得到两次比较之间落地的他人编辑。
      const operationId = admission.operationId;
      const after = await readComment(client, input.commentId);
      if (computeCommentVersion(parseTicketBody(after.body).body) !== input.expectedVersion) {
        await operations.fail({
          operationId,
          step: TICKET_OPERATION_STEP.upstreamFailed,
          result: toOperationFailureResult(new VersionConflictError()),
        });
        throw new VersionConflictError();
      }

      // 身份头来源（§3.5 的评论侧同口径）：有归属行就沿用它的 message_id 与作者（编辑不转移作者）。
      const existing = await messages.findObjectMessage({
        projectId: input.projectId,
        objectKind: "comment",
        providerObjectId: input.commentId,
      });
      const headerMessageId = existing?.messageId ?? admission.messageId ?? `msg_${randomUUID()}`;
      const headerAuthor =
        existing === undefined
          ? { id: input.actorId, name: input.actorName }
          : { id: existing.authorId, name: existing.authorNameSnapshot };

      let updated: GitComment;
      try {
        updated = await client.comments.edit(input.commentId, {
          body: buildTicketBody({
            header: {
              schema: 1,
              organizationId: input.organizationId,
              messageId: headerMessageId,
              author: headerAuthor,
            },
            body: input.body,
          }),
        });
      } catch (error) {
        await settleTicketWriteFailure({
          operations,
          operationId,
          error,
          toError: (failure) => toCommentWriteError(failure, "update"),
        });
        return { kind: "uncertain", operationId };
      }

      const version = computeCommentVersion(parseTicketBody(updated.body).body);
      try {
        await operations.checkpoint({
          operationId,
          step: TICKET_OPERATION_STEP.commentUpdated,
          expected: { commentId: updated.id, contentVersion: version },
        });
        await runInTransaction(async () => {
          const bodyHash = hashBody(parseTicketBody(updated.body).body);
          // §3.4：正文被改写才动归属行；`revision + 1` 与 `last_editor_id` 表达「谁改写了这一版」，
          // `author_id` 保持不变（编辑不转移作者）。无归属行（外部评论被管理员编辑）时新落一行。
          if (existing === undefined) {
            await messages.insert({
              projectId: input.projectId,
              objectKind: "comment",
              providerObjectId: updated.id,
              messageId: headerMessageId,
              authorId: input.actorId,
              authorNameSnapshot: input.actorName,
              bodyHash,
              revision: 1,
            });
          } else {
            await messages.updateRevision({ id: existing.id, bodyHash, lastEditorId: input.actorId });
          }
          await operations.succeed({
            operationId,
            step: TICKET_OPERATION_STEP.ownershipWritten,
            targetId: updated.id,
            result: { commentId: updated.id, issueNumber: updated.issueNumber, version },
            intentSummary: { bodyHash, issueNumber: updated.issueNumber },
          });
        });
      } catch (error) {
        return localWriteFailed({
          operationId,
          projectId: input.projectId,
          targetId: updated.id,
          targetKind: "comment",
          error,
        });
      }

      const message = await messages.findObjectMessage({
        projectId: input.projectId,
        objectKind: "comment",
        providerObjectId: updated.id,
      });
      return { kind: "written", operationId, facts: toCommentFacts(input.organizationId, updated, message) };
    },
  };
}

/** `intent.since`：领取时刻回拨一分钟，把恢复扫描收窄到本次操作附近（不进请求指纹，§5.1）。 */
function sinceForRecovery(): string {
  return new Date(Date.now() - RECOVERY_SINCE_SKEW_MS).toISOString();
}
