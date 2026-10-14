/**
 * 工单修改（`issue.update`）与标签挂载（`issue.labels`）的领域编排。三条顺序不可调换（§4.2 / §5.1 / §6.2）：
 * 1. 准入前的判定（绑定、标签映射、负责人核验、首次版本比较）都在领取之前，不产生账本行——否则一次
 *    400/404/409 会烧掉幂等键，同键重试再拿不到同一个答复；
 * 2. 领取后再回源一次，两次比较都以**回源结果**为准（绝不能拿 `ticket_index.content_version` 比较：管理端
 *    直改会让索引落后于远端，用索引比较会造成持续性的伪冲突）；
 * 3. 远端成功后本地失败返回 202 而不是抛错（远端已落库），账本保持 `dispatching`、step 停在远端那一步，
 *    由恢复核对按 `intent` 回源补齐（§6.2 条件 3）；身份头只在本次写入替换远端正文时重建（§3.5）。
 */

import { randomUUID } from "node:crypto";
import type { GitIssue, GitScopedClient, GitService } from "@fenix/git/server";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import { runInTransaction } from "@fenix/platform-sdk/server";
import {
  AssigneeNotMemberError,
  appErrorFromOperationResult,
  toOperationFailureResult,
  UnknownLabelError,
  VersionConflictError,
} from "../errors";
import { ticketsIssueLockKey } from "../repositories/advisory-lock";
import type { TicketIndexRepository } from "../repositories/ticket-index";
import type { TicketMessageRepository } from "../repositories/ticket-messages";
import { buildTicketBody, hashBody, type TicketIdentityHeader } from "./identity-header";
import { connectTicketGitClient } from "./ticket-git-client";
import {
  assembleIssueFacts,
  describeIssue,
  finalizeIssueWrite,
  readIssueForWrite,
  toIssueWriteError,
} from "./ticket-issue-write";
import { RECOVERY_SINCE_SKEW_MS } from "./ticket-limits";
import type { TicketOperationAdmission, TicketOperationService } from "./ticket-operation-service";
import { ISSUE_CHANGE_KINDS, TICKET_OPERATION_STEP } from "./ticket-operation-service";
import { hashTicketRequest, issueLabelsTargetPath, issueUpdateTargetPath } from "./ticket-request-hash";
import type { TicketIssueFacts } from "./ticket-service";
import { localWriteFailed, settleTicketWriteFailure } from "./ticket-write-failure";

/** 修改工单（标题/描述/负责人/状态）；字段缺席 = 不改，`assigneeId: null` = 取消指派。 */
export interface TicketUpdateIssueInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly issueNumber: string;
  readonly actorId: string;
  /** 操作者显示名：改描述且无归属行时铸进新身份头。 */
  readonly actorName: string;
  readonly expectedVersion: string;
  readonly title?: string;
  readonly body?: string;
  readonly assigneeId?: string | null;
  readonly state?: "open" | "closed";
  readonly idempotencyKey: string;
}

/** 全量设置工单标签集合；空数组 = 清空。 */
export interface TicketLabelSetInput {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly issueNumber: string;
  readonly actorId: string;
  readonly expectedVersion: string;
  readonly labelIds: readonly string[];
  readonly idempotencyKey: string;
}

export type TicketEditOutcome =
  | { readonly kind: "updated"; readonly operationId: string; readonly facts: TicketIssueFacts }
  | { readonly kind: "uncertain"; readonly operationId: string };

export interface TicketEditService {
  updateIssue(input: TicketUpdateIssueInput): Promise<TicketEditOutcome>;
  setLabels(input: TicketLabelSetInput): Promise<TicketEditOutcome>;
}

export interface TicketEditServiceDeps {
  readonly messages: TicketMessageRepository;
  readonly index: TicketIndexRepository;
  readonly operations: TicketOperationService;
  readonly git: GitService;
  readonly identity: IdentityDirectory;
}

interface TicketEditRun {
  readonly organizationId: string;
  readonly projectId: string;
  readonly bindingId: string;
  readonly issueNumber: string;
  readonly actorId: string;
  readonly expectedVersion: string;
  readonly idempotencyKey: string;
  readonly kind: "issue.update" | "issue.labels";
  readonly requestHash: () => string;
  readonly intent: () => Record<string, unknown>;
  readonly messageId: string | null;
  readonly precheck?: (client: GitScopedClient, current: GitIssue) => Promise<void>;
  /** 领取之后的执行体：一次远端写入 + 本地终态（含 202 收敛）。`current` 是领取后回源的工单。 */
  readonly execute: (
    client: GitScopedClient,
    current: GitIssue,
    operationId: string,
    messageId: string | null,
  ) => Promise<TicketEditOutcome>;
}

export function createTicketEditService(deps: TicketEditServiceDeps): TicketEditService {
  const { messages, index, operations, git, identity } = deps;

  /** 成功重放：允许一次远端读取用于组装视图（§5.4），**绝不**重放写入。 */
  async function replayIssue(
    input: TicketEditRun,
    admission: Extract<TicketOperationAdmission, { kind: "replayed" }>,
  ): Promise<TicketEditOutcome> {
    const issueNumber = typeof admission.result.issueNumber === "string" ? admission.result.issueNumber : null;
    // 成功终态的结果由本模块写入，缺坐标只可能是人工改库：报不变量违反，不猜一个工单号返回。
    if (issueNumber === null) throw new Error("工单修改操作已成功，但结果缺少工单坐标");
    const issue = await readIssueForWrite(await connectTicketGitClient(git, input), issueNumber);
    const [message, indexRow] = await Promise.all([
      messages.findObjectMessage({ projectId: input.projectId, objectKind: "issue", providerObjectId: issueNumber }),
      index.findByIssueNumber({ projectId: input.projectId, issueNumber }),
    ]);
    return {
      kind: "updated",
      operationId: admission.operationId,
      facts: assembleIssueFacts({ organizationId: input.organizationId, issue, indexRow, message }),
    };
  }

  /** 两条写路径的共同骨架：两次比较 → 领取 → 执行体（写远端 + 本地终态）。 */
  async function runEdit(input: TicketEditRun): Promise<TicketEditOutcome> {
    const client = await connectTicketGitClient(git, input);
    // 第一次比较（准入前）：不一致即 409 且不产生账本行（§4.2 判定点 1）。
    const current = await readIssueForWrite(client, input.issueNumber);
    if (describeIssue(current).version !== input.expectedVersion) throw new VersionConflictError();
    if (input.precheck !== undefined) await input.precheck(client, current);

    // 工单锁 + 在途互斥（§5.1 第 4 步）+ 幂等裁决；两条路径只在 kind/intent 上不同。
    const admission = await operations.begin({
      organizationId: input.organizationId,
      actorId: input.actorId,
      kind: input.kind,
      projectId: input.projectId,
      targetId: input.issueNumber,
      idempotencyKey: input.idempotencyKey,
      lockKey: ticketsIssueLockKey(input.projectId, input.issueNumber),
      guardKinds: ISSUE_CHANGE_KINDS,
      requestHash: input.requestHash(),
      messageId: input.messageId,
      expectedVersion: input.expectedVersion,
      intent: input.intent(),
      step: TICKET_OPERATION_STEP.dispatching,
    });
    if (admission.kind === "replayed") return await replayIssue(input, admission);
    if (admission.kind === "failed") throw appErrorFromOperationResult(admission.result);
    if (admission.kind === "in_flight") return { kind: "uncertain", operationId: admission.operationId };

    // 第二次比较：只有领取后的回源才看得到两次比较之间落地的其他写入（§4.2 判定点 2）。
    const operationId = admission.operationId;
    const after = await readIssueForWrite(client, input.issueNumber);
    if (describeIssue(after).version !== input.expectedVersion) {
      await operations.fail({
        operationId,
        step: TICKET_OPERATION_STEP.upstreamFailed,
        result: toOperationFailureResult(new VersionConflictError()),
      });
      throw new VersionConflictError();
    }
    return await input.execute(client, after, operationId, admission.messageId ?? input.messageId);
  }

  return {
    /** 标题/描述/负责人/状态的部分修改；`assigneeId: null` 是取消指派而不是「不改」。 */
    async updateIssue(input) {
      return await runEdit({
        // 坐标字段与 Run 同名，直接展开；多出的请求字段不会被 runEdit 读取。
        ...input,
        kind: "issue.update",
        messageId: `msg_${randomUUID()}`,
        requestHash: () =>
          hashTicketRequest({
            kind: "issue.update",
            targetPath: issueUpdateTargetPath(input.projectId, input.issueNumber),
            payload: {
              title: input.title,
              body: input.body,
              assigneeId: input.assigneeId,
              state: input.state,
              expectedVersion: input.expectedVersion,
            },
          }),
        intent: () => ({
          title: input.title,
          body: input.body,
          assigneeId: input.assigneeId,
          state: input.state,
          expectedVersion: input.expectedVersion,
          // 通用锚点：恢复核对把扫描面收窄到本次操作附近（不进请求指纹，§5.1）。
          since: new Date(Date.now() - RECOVERY_SINCE_SKEW_MS).toISOString(),
        }),
        // §3.3：负责人必须现查成员关系（含已离职）；领取之前判定，不产生账本行。
        precheck: async () => {
          if (input.assigneeId === undefined || input.assigneeId === null) return;
          const membershipId = await identity.resolveMembershipId({
            organizationId: input.organizationId,
            userId: input.assigneeId,
          });
          if (membershipId === undefined) throw new AssigneeNotMemberError();
        },
        execute: async (client, current, operationId, messageId) => {
          const headerMessageId = messageId ?? "";
          // 领取后读一次归属行与索引行：远端正文的头来源与本地收尾都据此决定。
          const [existingMessage, indexRow] = await Promise.all([
            messages.findObjectMessage({
              projectId: input.projectId,
              objectKind: "issue",
              providerObjectId: input.issueNumber,
            }),
            index.findByIssueNumber({ projectId: input.projectId, issueNumber: input.issueNumber }),
          ]);
          const nextAssigneeId = input.assigneeId !== undefined ? input.assigneeId : (indexRow?.assigneeId ?? null);
          // 头来源三分支（§3.5）：归属行存在就用它；改描述且无归属行则以操作者新铸；否则本次不写远端正文。
          const headerSource =
            existingMessage === undefined
              ? input.body === undefined
                ? null
                : { messageId: headerMessageId, authorId: input.actorId, authorName: input.actorName }
              : {
                  messageId: existingMessage.messageId,
                  authorId: existingMessage.authorId,
                  authorName: existingMessage.authorNameSnapshot,
                };
          const wantsBody = input.body !== undefined || (input.assigneeId !== undefined && headerSource !== null);
          const remoteBody = wantsBody ? (input.body ?? describeIssue(current).body) : undefined;

          const editInput: { title?: string; body?: string; state?: "open" | "closed" } = {};
          if (input.title !== undefined) editInput.title = input.title;
          if (input.state !== undefined) editInput.state = input.state;
          if (remoteBody !== undefined && headerSource !== null) {
            const header: TicketIdentityHeader = {
              schema: 1,
              organizationId: input.organizationId,
              messageId: headerSource.messageId,
              author: { id: headerSource.authorId, name: headerSource.authorName },
              ...(nextAssigneeId === null ? {} : { ticket: { assigneeId: nextAssigneeId } }),
            };
            editInput.body = buildTicketBody({ header, body: remoteBody });
          }

          let edited: GitIssue;
          try {
            // 只改指派且没有头来源时不发任何字段：本地落库即可，不给外部工单伪造 AOS 作者。
            const untouched =
              editInput.title === undefined && editInput.body === undefined && editInput.state === undefined;
            edited = untouched ? current : await client.issues.edit(input.issueNumber, editInput);
          } catch (error) {
            // 未定落 `uncertain` 后返回 202；确定失败写完终态并抛出（同键重放由账本还原同一个错误）。
            await settleTicketWriteFailure({ operations, operationId, error, toError: toIssueWriteError });
            return { kind: "uncertain", operationId };
          }

          const echoed = describeIssue(edited);
          try {
            // 远端那一步先单独写入账本（独立语句）：本地事务失败时 `step` 必须停在 `issue_updated`，
            // 恢复核对与排障据此区分「远端已写、本地未记」与「领取了但什么都没做」（§6.1 / §6.2 条件 3）。
            await operations.checkpoint({
              operationId,
              step: TICKET_OPERATION_STEP.issueUpdated,
              expected: { issueNumber: edited.number, contentVersion: echoed.version },
            });
            const settled = await runInTransaction(async () => {
              // §3.4：只有描述被改写才动归属行（`revision` 表达正文被改写了几次）；标题/状态/指派由账本记账。
              let message = existingMessage;
              if (input.body !== undefined) {
                const bodyHash = hashBody(remoteBody ?? input.body);
                message =
                  existingMessage === undefined
                    ? await messages.insert({
                        projectId: input.projectId,
                        objectKind: "issue",
                        providerObjectId: edited.number,
                        messageId: headerMessageId,
                        authorId: input.actorId,
                        authorNameSnapshot: input.actorName,
                        bodyHash,
                        revision: 1,
                      })
                    : await messages.updateRevision({ id: existingMessage.id, bodyHash, lastEditorId: input.actorId });
              }
              const written = await finalizeIssueWrite(
                { operations, index },
                {
                  operationId,
                  projectId: input.projectId,
                  issue: edited,
                  version: echoed.version,
                  step: TICKET_OPERATION_STEP.indexWritten,
                  // 索引的 author 列只从归属行或既有索引继承：本地刷新绝不把作者写空（T04 同步同受此约束）。
                  authorship: {
                    authorId: message?.authorId ?? indexRow?.authorId ?? null,
                    authorName: message?.authorNameSnapshot ?? indexRow?.authorName ?? null,
                    assigneeId: nextAssigneeId,
                  },
                  intentSummary: { titleLength: edited.title.length, bodyHash: hashBody(echoed.body) },
                },
              );
              return { index: written, message };
            });
            return {
              kind: "updated",
              operationId,
              facts: assembleIssueFacts({
                organizationId: input.organizationId,
                issue: edited,
                indexRow: settled.index,
                message: settled.message,
              }),
            };
          } catch (error) {
            return localWriteFailed({
              operationId,
              projectId: input.projectId,
              targetId: edited.number,
              targetKind: "issue",
              error,
            });
          }
        },
      });
    },

    /** 标签全量挂载（不是增量）：`labelIds` 是「设置后应当只剩这些」，空数组表示清空。 */
    async setLabels(input) {
      // 标签 ID → 名字的映射必须在领取前完成（未知标签是 400 且零写入），结果供写远端与 intent 共用。
      let labelNames: string[] = [];
      let beforeLabelNames: string[] = [];

      return await runEdit({
        // 坐标字段与 Run 同名，直接展开；多出的请求字段不会被 runEdit 读取。
        ...input,
        kind: "issue.labels",
        messageId: null,
        requestHash: () =>
          hashTicketRequest({
            kind: "issue.labels",
            targetPath: issueLabelsTargetPath(input.projectId, input.issueNumber),
            payload: { labelIds: input.labelIds, expectedVersion: input.expectedVersion },
          }),
        intent: () => ({
          labelNames,
          // 「远端确定未落库」的判据：回源集合仍等于改前集合，说明这次 PUT 没有生效（§8.3）。
          beforeLabelNames,
          expectedVersion: input.expectedVersion,
          since: new Date(Date.now() - RECOVERY_SINCE_SKEW_MS).toISOString(),
        }),
        precheck: async (client, current) => {
          // §7.2：映射必须逐个命中，任一未知即 400 且零写入（静默丢弃会让用户以为挂上了）。
          const known = new Map((await client.labels.list()).map((label) => [label.id, label.name]));
          labelNames = input.labelIds.map((labelId) => {
            const name = known.get(labelId);
            if (name === undefined) throw new UnknownLabelError();
            return name;
          });
          beforeLabelNames = current.labels.map((label) => label.name);
        },
        execute: async (client, _current, operationId) => {
          let updated: GitIssue;
          try {
            updated = await client.issues.setLabels(input.issueNumber, labelNames);
          } catch (error) {
            await settleTicketWriteFailure({ operations, operationId, error, toError: toIssueWriteError });
            return { kind: "uncertain", operationId };
          }
          const echoed = describeIssue(updated);
          try {
            // 与 updateIssue 同理：先单独提交「远端那一步已确认」，本地事务失败时 step 停在 labels_updated。
            await operations.checkpoint({
              operationId,
              step: TICKET_OPERATION_STEP.labelsUpdated,
              expected: { issueNumber: updated.number, labelNames: echoed.labelNames },
            });
            const settled = await runInTransaction(async () => {
              // 标签挂载不碰作者与负责人：只继承既有索引行，绝不把这两列写空（§3.3）。
              const [message, row] = await Promise.all([
                messages.findObjectMessage({
                  projectId: input.projectId,
                  objectKind: "issue",
                  providerObjectId: updated.number,
                }),
                index.findByIssueNumber({ projectId: input.projectId, issueNumber: updated.number }),
              ]);
              const written = await finalizeIssueWrite(
                { operations, index },
                {
                  operationId,
                  projectId: input.projectId,
                  issue: updated,
                  version: echoed.version,
                  step: TICKET_OPERATION_STEP.indexWritten,
                  authorship: {
                    authorId: row?.authorId ?? null,
                    authorName: row?.authorName ?? null,
                    assigneeId: row?.assigneeId ?? null,
                  },
                  intentSummary: { labelNames: echoed.labelNames, labelCount: echoed.labelNames.length },
                },
              );
              return { index: written, message };
            });
            return {
              kind: "updated",
              operationId,
              facts: assembleIssueFacts({
                organizationId: input.organizationId,
                issue: updated,
                indexRow: settled.index,
                message: settled.message,
              }),
            };
          } catch (error) {
            return localWriteFailed({
              operationId,
              projectId: input.projectId,
              targetId: updated.number,
              targetKind: "issue",
              error,
            });
          }
        },
      });
    },
  };
}
