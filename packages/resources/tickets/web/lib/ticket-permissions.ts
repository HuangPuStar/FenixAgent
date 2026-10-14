/**
 * 工单界面上的**入口可见性**判定（纯逻辑：不 import React、不读 i18n、不依赖图标包）。
 *
 * 这里判的只是「按钮给不给看」，不是授权：授权一律在服务端（`ticket-permission.ts`），界面隐藏入口
 * 只影响可操作性，不构成安全边界。因此凡是不确定的情形一律**少显示**，而不是多显示。
 */

import type { TicketComment } from "../api/ticket-comments";

/**
 * 评论「编辑」入口的可见性：**只认作者本人**。
 *
 * 规则缺口（已登记，见 T03 裁定三.17）：方案 §7 允许组织管理员编辑他人评论，但会话投影只有 `isOwner`
 * （`@fenix/web-runtime/contexts/org-session` 刻意不外泄角色枚举），非 owner 的管理员在界面上拿不到入口。
 * 这是可见性缺口而非越权——服务端仍按规则放行。解除条件：会话投影补 `isAdmin`，或详情视图返回
 * `viewerPermissions`；两者出现任一后把管理员并进本判定。
 *
 * 两条边界：`external` 来源的作者 `id` 恒为 `null`，天然不会被判成「本人」；会话未就绪（`userId` 为
 * `null`）时同样判否——宁可少显示一个入口，也不误显示成「可以编辑别人的评论」。
 */
export function canEditComment(comment: TicketComment, viewer: { userId: string | null }): boolean {
  return comment.author.source === "aos" && comment.author.id !== null && comment.author.id === viewer.userId;
}
