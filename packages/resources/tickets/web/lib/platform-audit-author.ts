/**
 * 平台审计主体的会话内识别：管理面写入的评论该显示成谁。
 *
 * **问题**：管理面的写路径以**系统托管租户**为主体（服务端 `ticket-platform-context.ts` 的 `auditActor()`），
 * 而这条身份在评论视图里与其他 AOS 用户长得**一模一样**：`{ id, name, source: "aos" }`，`name` 取身份目录里
 * 该账号的当前名（部署期的系统账号名）。也就是说，光看一条评论，前端无法把它与某个组织成员区分开——而把它
 * 当组织成员渲染正是错的（它会顶着系统账号的名字出现，看起来像某个真实用户）。
 *
 * **本模块只用一个不会误判的信号**：本页经平台面写入过的评论（写响应带 `commentId`，由数据源在响应后登记）。
 * 页面据此把作者呈现为「平台系统管理员」，而不是身份目录里的账号名。登记过的评论一旦在后续读取里解析出真实
 * 作者 id，就把该 id 也记为平台审计主体——于是**同一主体此前写的评论**也一并被认出来，覆盖率随本会话的一次
 * 列表读取提升，而不是只覆盖「刚写的那一条」。
 *
 * 已知边界（协议缺口，**未**自行改服务端）：服务端目前不暴露审计主体标识（评论视图没有平台标记，也没有解析
 * 系统托管租户的端点），因此**从未在本会话经平台面写入过**的历史评论无法被识别，仍会显示身份目录里的账号名。
 * 解除条件：评论/详情视图给出平台标记（如 `author.platform`），或提供一条解析系统托管租户的端点——两者任一
 * 落地后，删掉这里的「学习」逻辑，改成直接比对即可。
 *
 * 纯逻辑：不 import React、不读 i18n（展示名由调用方传入），可在不知晓界面语言的地方被数据源调用。
 */

import type { TicketComment } from "../api/ticket-comments";

/** 本会话经平台面写入过的评论 id（唯一不会误判的信号，见文件头）。 */
const platformWrittenCommentIds = new Set<string>();

/** 会话内学到的平台审计主体 id：由「登记过的评论」在后续读取里解析出的真实作者推导。 */
const platformAuditAuthorIds = new Set<string>();

/** 数据源在平台写入成功后调用：登记这条评论是本页经平台面写的。 */
export function rememberPlatformWrittenComment(commentId: string): void {
  platformWrittenCommentIds.add(commentId);
}

/**
 * 数据源在**每一次**评论读取/写响应后调用：登记过的评论若已解析出真实作者 id，该 id 即平台审计主体。
 *
 * 只从登记过的评论推导（而不是「凡是作者不是组织成员就当平台主体」）：后者是猜——离职成员、跨组织账号都会
 * 命中，把一条组织成员写的评论标成平台管理员比不标更坏。
 */
export function learnPlatformAuditAuthors(comments: readonly TicketComment[]): void {
  for (const comment of comments) {
    if (!platformWrittenCommentIds.has(comment.commentId)) continue;
    if (comment.author.id !== null) platformAuditAuthorIds.add(comment.author.id);
  }
}

/**
 * 一条评论的作者是否为平台审计主体。两条判据缺一不可：
 *
 * 1. **本页经平台面写过的那条**（按 `commentId`）：它是唯一**无需推断**的信号，而且必须单独成立——刚写入的
 *    评论在写响应里作者恒为 `external` / `id: null`（服务端写入路径不回读刚落的归属行），此时按 id 判会漏掉
 *    操作者自己刚发的那条，正是「不能给操作者自己的评论打外部角标」要避免的情况；
 * 2. **会话内学到的审计主体 id**（按 `author.id`）：覆盖同一主体**此前**写的评论（见 `learnPlatformAuditAuthors`）。
 */
export function isPlatformAuthoredComment(comment: TicketComment): boolean {
  if (platformWrittenCommentIds.has(comment.commentId)) return true;
  return comment.author.id !== null && platformAuditAuthorIds.has(comment.author.id);
}

/** 会话内已知的平台审计主体 id（排障与用例断言用；界面渲染不依赖它的具体取值）。 */
export function platformAuditAuthorIdsSnapshot(): string[] {
  return [...platformAuditAuthorIds];
}

/** 清空会话内识别结果。仅供用例在每例之间复位（进程级状态不跨用例复用）。 */
export function clearPlatformAuditAuthors(): void {
  platformWrittenCommentIds.clear();
  platformAuditAuthorIds.clear();
}

/**
 * 把作者是平台审计主体的评论投影成**平台视图**：作者名换成调用方给的展示名（「平台系统管理员」），来源记为
 * 受信。两处改动的理由：
 *
 * 1. 交付口径要求平台审计主体**如实**呈现为系统管理员，而不是身份目录里的账号名，也不是任何组织成员的
 *    名字；
 * 2. 刚写入的评论在写响应里是 `external`（服务端写入路径不回读刚落的归属行），若原样渲染，操作者会在**自己
 *    刚发的**评论上看到「外部来源／待核对」——那是一句假警报：这条评论正是本页持系统凭据写的，归属不存在
 *    疑问。因此只对**已识别为平台审计主体**的评论把 `source` 记为受信，其余（真正的 `external`）不动。
 *
 * 非平台主体的评论原样返回（同一个对象引用），调用方无需分支。
 */
export function toPlatformCommentView(comment: TicketComment, displayName: string): TicketComment {
  if (!isPlatformAuthoredComment(comment)) return comment;
  return { ...comment, author: { id: comment.author.id, name: displayName, source: "aos" } };
}
