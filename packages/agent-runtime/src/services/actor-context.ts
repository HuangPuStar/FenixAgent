import type { ActorContext } from "@fenix/platform-sdk";

/**
 * 宿主 `AuthContext` → 平台可信主体 `ActorContext` 的**过渡转换**，规则与宿主
 * `apps/server/src/plugins/auth.ts` 的 `toActorContext` 逐字对齐。
 *
 * 为什么在本包内转换：`@fenix/agent-config` 的系统入口只接受已转换的 `ActorContext`（资源包不得
 * 解释宿主的 `role` 与成员关系），而本包这几处调用点仍持有宿主的 `AuthContext`——`@server` 深链的
 * 收敛属宿主协议任务，改签名会波及宿主 route 与注入端口，超出当前修复范围。
 *
 * 为什么可以内联副本：回退规则（成员关系缺失时用「当前组织 + 当前角色」）必须与宿主一致，否则同一
 * 主体经两条路径会得到不同的成员关系。这些调用点都是**只读**路径（`read` 对所有成员开放，公开资源
 * 对所有已认证用户开放），构造出的角色不构成权限提升；成员关系完整时原样透传。
 *
 * 移除条件：宿主协议收敛后调用方直接持有 `ActorContext`，随本文件一并删除。
 */
export type MemberRole = ActorContext["memberships"][number]["role"];

/** {@link toActorContext} 的输入：与宿主 `AuthContext` 同形，但本包只消费主体投影所需的字段。 */
export interface ActorProjection {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
  readonly memberships?: ActorContext["memberships"];
}

/** 授权谓词只认这三个角色；未知角色按最小权限收敛，不把自由字符串带进授权面。 */
const ACTOR_ROLES = new Set<MemberRole>(["owner", "admin", "member"]);

function normalizeActorRole(role: string): MemberRole {
  return ACTOR_ROLES.has(role as MemberRole) ? (role as MemberRole) : "member";
}

/** 把宿主的主体投影为 `ActorContext`。 */
export function toActorContext(ctx: ActorProjection): ActorContext {
  return {
    kind: "user",
    userId: ctx.userId,
    activeOrganizationId: ctx.organizationId,
    memberships: ctx.memberships ?? [{ organizationId: ctx.organizationId, role: normalizeActorRole(ctx.role) }],
  };
}
