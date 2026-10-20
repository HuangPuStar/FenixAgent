/**
 * 恢复核对的工单域判定：`issue.create` / `issue.update` / `issue.labels` 三条口径（backend contract §8.3）。
 *
 * 三个 kind 共用一份「回源读 → 与 intent 比对 → 给出结论」的形状，`apply` 里的本地补齐（索引 + 归属行）
 * 由流程侧放进落终态的同一事务执行。
 *
 * 两条容易做错的边界：
 * - 创建类**不判定未落库**：找不到就是 `unmatched`（保持未定），绝不因窗口内没扫到而认定失败（§9.6）。
 * - `issue.update` 的指派不进内容指纹，单独用身份头的 `ticket.assignee_id` 核对（远端 `assignees` 表达的是
 *   服务账号，见 §3.3）；「不改描述」的请求远端根本收不到指派写入，指派只落在本端，因此直接算已生效。
 */

import type { GitIssue } from "@fenix/git/server";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import type { TicketIndexRepository } from "../repositories/ticket-index";
import type { TicketMessageRepository } from "../repositories/ticket-messages";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import { computeContentVersion } from "./content-version";
import { hashBody, parseTicketBody } from "./identity-header";
import { RECOVERY_SCAN_PAGE_LIMIT } from "./ticket-limits";
import { TICKET_OPERATION_STEP } from "./ticket-operation-service";
import {
  intentAssignee,
  intentNames,
  intentString,
  issueVersion,
  isUnapplied,
  matchesCreated,
  type RecoveryRemote,
  type RecoveryVerdict,
  readOrNull,
  resolveAuthorName,
  sameNames,
  scanPages,
  sinceQuery,
  uniqueMatch,
  upsertIssueIndex,
} from "./ticket-recovery-shared";

/** 工单域判定需要的本地仓储：归属行（作者核验的依据）与索引（补齐本地写）。 */
export interface RecoveryIssueContext {
  readonly index: TicketIndexRepository;
  readonly messages: TicketMessageRepository;
  readonly identity: IdentityDirectory;
}

/**
 * `issue.create`：按 `intent.since` 起有界翻页，用「`message_id` + 正文摘要」唯一命中远端工单。
 *
 * 命中后补齐两处本地写：索引行，以及创建时应当写入的归属行（若崩溃前已写过则不动）。
 */
export async function inspectIssueCreate(
  ctx: RecoveryIssueContext,
  row: TicketOperationRow,
  projectId: string,
  remote: RecoveryRemote,
): Promise<RecoveryVerdict> {
  if (row.messageId === null) return { kind: "ambiguous" };
  const candidates = await scanPages((cursor) =>
    remote.issues.list({
      state: "all",
      limit: RECOVERY_SCAN_PAGE_LIMIT,
      ...sinceQuery(row),
      ...(cursor === undefined ? {} : { cursor }),
    }),
  );
  const matched = uniqueMatch(
    candidates.filter((issue) => matchesCreated(issue.body, row.messageId, intentString(row, "body"))),
  );
  if (matched === "ambiguous" || matched === "unmatched") return { kind: matched };

  const issue = matched;
  const parsed = parseTicketBody(issue.body);
  const version = issueVersion(issue, parsed.body);
  const authorName = await resolveAuthorName(ctx.identity, row.actorId, parsed.header);
  const messageId = row.messageId;
  return {
    kind: "applied",
    step: TICKET_OPERATION_STEP.indexWritten,
    targetId: issue.number,
    result: { issueNumber: issue.number, version },
    intentSummary: { titleLength: issue.title.length, bodyHash: hashBody(parsed.body) },
    apply: async () => {
      const existing = await ctx.messages.findObjectMessage({
        projectId,
        objectKind: "issue",
        providerObjectId: issue.number,
      });
      if (existing === undefined) {
        await ctx.messages.insert({
          projectId,
          objectKind: "issue",
          providerObjectId: issue.number,
          messageId,
          authorId: row.actorId,
          authorNameSnapshot: authorName,
          bodyHash: hashBody(parsed.body),
          revision: 1,
        });
      }
      await upsertIssueIndex(ctx.index, {
        projectId,
        issue,
        version,
        authorId: row.actorId,
        authorName,
        assigneeId: parsed.header?.ticket?.assigneeId ?? null,
      });
    },
  };
}

/**
 * `issue.update`：回源单条工单，比较「目标指纹」（`intent` 里缺席的字段沿用回源值）与指派事实。
 *
 * 本地补齐先确认归属行当前状态（事务内可能已被并发核对改过），再刷新索引；作者列只从既有行继承，
 * 绝不写空（§3.4）。
 */
export async function inspectIssueUpdate(
  ctx: RecoveryIssueContext,
  row: TicketOperationRow,
  projectId: string,
  remote: RecoveryRemote,
): Promise<RecoveryVerdict> {
  const issueNumber = row.targetId;
  if (issueNumber === null) return { kind: "unmatched" };
  const issue = await readOrNull(() => remote.issues.get(issueNumber));
  if (issue === null) return { kind: "unmatched" };

  const parsed = parseTicketBody(issue.body);
  const remoteVersion = issueVersion(issue, parsed.body);
  const targetVersion = targetVersionOf(row, issue, parsed.body);
  const existing = await ctx.messages.findObjectMessage({
    projectId,
    objectKind: "issue",
    providerObjectId: issueNumber,
  });
  const requestedAssignee = intentAssignee(row);
  const intentBody = intentString(row, "body");
  const assigneeApplied =
    requestedAssignee === undefined ||
    (existing === undefined && intentBody === null) ||
    (parsed.header?.ticket?.assigneeId ?? null) === requestedAssignee;

  if (remoteVersion !== targetVersion || !assigneeApplied) {
    return isUnapplied(row, remoteVersion) ? { kind: "not_applied" } : { kind: "unmatched" };
  }

  const existingRow = await ctx.index.findByIssueNumber({ projectId, issueNumber });
  const headerMessageId = parsed.header?.messageId ?? row.messageId;
  const needsOwnership = intentBody !== null && existing === undefined;
  // 要补归属行却拿不到 message_id：远端正文不是本次写入的产物，交人工核对而不是猜一个 id。
  if (needsOwnership && headerMessageId === null) return { kind: "ambiguous" };
  const authorName = needsOwnership ? await resolveAuthorName(ctx.identity, row.actorId, parsed.header) : null;
  return {
    kind: "applied",
    step: TICKET_OPERATION_STEP.indexWritten,
    targetId: issue.number,
    result: { issueNumber: issue.number, version: remoteVersion },
    intentSummary: { titleLength: issue.title.length, bodyHash: hashBody(parsed.body) },
    apply: async () => {
      const currentMessage = await ctx.messages.findObjectMessage({
        projectId,
        objectKind: "issue",
        providerObjectId: issueNumber,
      });
      if (intentBody !== null) {
        const bodyHash = hashBody(parsed.body);
        if (currentMessage === undefined) {
          await ctx.messages.insert({
            projectId,
            objectKind: "issue",
            providerObjectId: issue.number,
            messageId: headerMessageId ?? "",
            authorId: row.actorId,
            authorNameSnapshot: authorName ?? row.actorId,
            bodyHash,
            revision: 1,
          });
        } else {
          await ctx.messages.updateRevision({ id: currentMessage.id, bodyHash, lastEditorId: row.actorId });
        }
      }
      // 作者列只从归属行/既有索引继承，本地补齐绝不把作者写空（§3.4 / T04 同受此约束）。
      await upsertIssueIndex(ctx.index, {
        projectId,
        issue,
        version: remoteVersion,
        authorId: currentMessage?.authorId ?? existingRow?.authorId ?? row.actorId,
        authorName: currentMessage?.authorNameSnapshot ?? existingRow?.authorName ?? authorName ?? row.actorId,
        assigneeId: requestedAssignee === undefined ? (existingRow?.assigneeId ?? null) : requestedAssignee,
      });
    },
  };
}

/**
 * `issue.labels`：回源工单比较标签名集合（全量集合语义）。
 *
 * 集合仍等于 `intent.beforeLabelNames` → 那次 PUT 未生效（`not_applied`）；补齐本地写只刷新索引，
 * 不碰作者与负责人（与写路径的收尾同口径）。
 */
export async function inspectIssueLabels(
  ctx: RecoveryIssueContext,
  row: TicketOperationRow,
  projectId: string,
  remote: RecoveryRemote,
): Promise<RecoveryVerdict> {
  const issueNumber = row.targetId;
  if (issueNumber === null) return { kind: "unmatched" };
  const issue = await readOrNull(() => remote.issues.get(issueNumber));
  if (issue === null) return { kind: "unmatched" };

  const currentNames = issue.labels.map((label) => label.name);
  const targetNames = intentNames(row, "labelNames");
  const beforeNames = intentNames(row, "beforeLabelNames");
  if (targetNames === null || !sameNames(currentNames, targetNames)) {
    if (beforeNames !== null && sameNames(currentNames, beforeNames)) return { kind: "not_applied" };
    return { kind: "unmatched" };
  }
  const version = issueVersion(issue, parseTicketBody(issue.body).body);
  return {
    kind: "applied",
    step: TICKET_OPERATION_STEP.indexWritten,
    targetId: issue.number,
    result: { issueNumber: issue.number, version },
    intentSummary: { labelNames: currentNames, labelCount: currentNames.length },
    apply: async () => {
      const existingRow = await ctx.index.findByIssueNumber({ projectId, issueNumber });
      await upsertIssueIndex(ctx.index, {
        projectId,
        issue,
        version,
        authorId: existingRow?.authorId ?? null,
        authorName: existingRow?.authorName ?? null,
        assigneeId: existingRow?.assigneeId ?? null,
      });
    },
  };
}

/** 目标指纹：`intent` 里缺席的字段沿用回源值——只比较本次要改的那几项，不受无关字段影响。 */
function targetVersionOf(row: TicketOperationRow, issue: GitIssue, body: string): string {
  return computeContentVersion({
    title: intentString(row, "title") ?? issue.title,
    body: intentString(row, "body") ?? body,
    state: (intentString(row, "state") as GitIssue["state"] | null) ?? issue.state,
    labelNames: issue.labels.map((label) => label.name),
  });
}
