/**
 * 恢复核对的**分派入口**：解析操作行 → 打开绑定 → 按 `kind` 交给对应域的判定文件。
 *
 * 判定口径按域拆在三个文件里（`ticket-recovery-issue.ts` / `-comment.ts` / `-label.ts`），共用读原语在
 * `ticket-recovery-shared.ts`；本文件只保留「怎么找到远端」与分派，因此改一条匹配判据时不必在几百行里
 * 定位它属于哪一步。
 *
 * 两条前置口径：
 * - 操作行的 `projectId` 缺失、项目不存在或组织不符 → `unmatched`（不产生结论）；没有核对口径的 kind
 *   （`project.provision`）同样 `unmatched`。
 * - 绑定握手失败经 `connectTicketGitClient` 收敛成 503（装配/数据故障），不得伪装成「未找到」。
 */

import type { GitService } from "@fenix/git/server";
import type { IdentityDirectory } from "@fenix/platform-sdk";
import type { TicketIndexRepository } from "../repositories/ticket-index";
import type { TicketMessageRepository } from "../repositories/ticket-messages";
import type { TicketOperationRow } from "../repositories/ticket-operations";
import type { TicketProjectRepository } from "../repositories/ticket-projects";
import { connectTicketGitClient } from "./ticket-git-client";
import { inspectCommentCreate, inspectCommentUpdate } from "./ticket-recovery-comment";
import { inspectIssueCreate, inspectIssueLabels, inspectIssueUpdate } from "./ticket-recovery-issue";
import { inspectLabel } from "./ticket-recovery-label";
import type { RecoveryRemote, RecoveryVerdict } from "./ticket-recovery-shared";

export interface TicketRecoveryInspectDeps {
  readonly git: GitService;
  /** 解析 `projectId → 绑定`；核对不做授权判定（可见性由操作行与他本人的关系决定）。 */
  readonly projects: TicketProjectRepository;
  readonly index: TicketIndexRepository;
  readonly messages: TicketMessageRepository;
  /** 补齐归属行时的作者显示名；缺失只影响展示快照，不影响归属判定。 */
  readonly identity: IdentityDirectory;
}

export interface TicketRecoveryInspector {
  /** 按 `kind` 分派核对口径；没有核对口径的 kind（`project.provision`）返回「未找到」，不产生任何结论。 */
  inspect(row: TicketOperationRow): Promise<RecoveryVerdict>;
}

export function createTicketRecoveryInspector(deps: TicketRecoveryInspectDeps): TicketRecoveryInspector {
  return {
    async inspect(row) {
      const projectId = row.projectId;
      if (projectId === null) return { kind: "unmatched" };
      const project = await deps.projects.findByIdUnscoped(projectId);
      if (project === undefined || project.organizationId !== row.organizationId) return { kind: "unmatched" };
      const client = await connectTicketGitClient(deps.git, {
        organizationId: row.organizationId,
        projectId,
        bindingId: project.repositoryRef,
      });
      const remote: RecoveryRemote = { issues: client.issues, comments: client.comments, labels: client.labels };
      const issueCtx = { index: deps.index, messages: deps.messages, identity: deps.identity };
      const commentCtx = { messages: deps.messages, identity: deps.identity };
      switch (row.kind) {
        case "issue.create":
          return await inspectIssueCreate(issueCtx, row, projectId, remote);
        case "issue.update":
          return await inspectIssueUpdate(issueCtx, row, projectId, remote);
        case "issue.labels":
          return await inspectIssueLabels(issueCtx, row, projectId, remote);
        case "comment.create":
          return await inspectCommentCreate(commentCtx, row, projectId, remote);
        case "comment.update":
          return await inspectCommentUpdate(commentCtx, row, projectId, remote);
        case "label.create":
        case "label.update":
          return await inspectLabel(row, remote);
        default:
          return { kind: "unmatched" };
      }
    },
  };
}
