import type { MemberRole } from "@fenix/platform-sdk";

/**
 * 把 `member.role` 收窄到契约取值域。
 *
 * 角色列是自由文本（历史数据可能写入非三态值）；契约是既有权限体系的取值域，未知值退化为最小权限
 * `member`，与 web 组织列表补角色时的 `?? "member"` 口径一致。
 *
 * 规则抽成共用实现而不是各写一份：`IdentityDirectory.listMemberships`（session 路径的组织上下文）
 * 与凭据路径（API key / Environment Secret）产出的是同一个 `ActorContext.memberships`，两处口径
 * 一旦漂移，授权结果就会随入口不同而不同。
 */
export function toMemberRole(role: string | null): MemberRole {
  return role === "owner" || role === "admin" ? role : "member";
}
