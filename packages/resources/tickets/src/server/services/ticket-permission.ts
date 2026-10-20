/**
 * 工单域动作权限（方案 §7 的逐条落实）。
 *
 * 为什么做成纯函数：同一条规则要服务 4 个入口（工单 PATCH、标签 PUT、评论 PATCH、评论列表的展示提示），
 * 写成 if 分支散在 Facade 里，改一次规则就要改四处，且「作者不可信」这条最关键的判定会被稀释成某处的
 * 一个 `??` 兜底。这里只吃两个输入——调用方已判定的管理员身份 + 对象的 AOS 归属 ID——
 * 因此「外部来源（authorId === null）只有管理员能动」是**类型层面**就能看出的规则，而不是被记住的约定。
 *
 * 本文件不做任何 IO：管理员身份由 Facade 经 `AccessControlModule` 判定后传入（`ticket-action-guard.ts`），
 * 对象的 `authorId` 只来自 `ticket_messages` 的归属核验结论，绝不取自请求体或身份头自填值。
 */

export interface TicketAuthority {
  readonly actorId: string;
  /** 组织 owner/admin（由 Facade 经 AccessControlModule 判定，本文件不做 IO）。 */
  readonly isOrganizationAdmin: boolean;
}

/** 标题与描述：创建者或管理员。`authorId === null`（未通过归属核验的外部内容）只有管理员可改。 */
export function canEditTicketContent(authority: TicketAuthority, issue: { readonly authorId: string | null }): boolean {
  if (authority.isOrganizationAdmin) return true;
  return issue.authorId !== null && issue.authorId === authority.actorId;
}

/** 指派、关闭与重开：创建者、当前负责人或管理员。 */
export function canChangeIssueStateOrAssignee(
  authority: TicketAuthority,
  issue: { readonly authorId: string | null; readonly assigneeId: string | null },
): boolean {
  if (authority.isOrganizationAdmin) return true;
  return (
    (issue.authorId !== null && issue.authorId === authority.actorId) ||
    (issue.assigneeId !== null && issue.assigneeId === authority.actorId)
  );
}

/** 编辑评论：原作者或管理员。 */
export function canEditComment(authority: TicketAuthority, comment: { readonly authorId: string | null }): boolean {
  if (authority.isOrganizationAdmin) return true;
  return comment.authorId !== null && comment.authorId === authority.actorId;
}
