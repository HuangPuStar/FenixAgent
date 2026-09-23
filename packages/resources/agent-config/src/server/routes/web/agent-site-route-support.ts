import type { ActorContext, WebErr } from "@fenix/platform-sdk";
import { findAgentConfigNamesByIds } from "../../repositories/agent-config";
import type { AgentSiteAppRow } from "../../repositories/agent-site-app";
import { agentSiteAppRepo } from "../../repositories/agent-site-app";
import type { AgentSiteApp } from "../../schemas/agent-site.schema";

/**
 * 站点路由使用的组织维度身份：组织、用户与**当前组织的成员角色**。
 *
 * 从可信主体 `ActorContext` 解析角色，而不是读宿主的 `AuthContext.role`（1.2 决策：「资源包与平台实现
 * 都只消费 `ActorContext`，不得自行解释 `AuthContext.role`」）：角色在本包只有一处用途——判断能否
 * 写站点（owner / admin），因此取 active organization 对应的成员关系即可。
 *
 * 无法解析（无 active organization，或该组织不在 `memberships` 中）时返回 null：这种主体无法定位组织
 * 资源，调用方按 401 短路，而不是让后续的比较把 `undefined` 当成一个组织去匹配。
 */
export interface SiteActor {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: string;
}

export function resolveSiteActor(actor: ActorContext | null | undefined): SiteActor | null {
  const organizationId = actor?.activeOrganizationId;
  if (actor == null || organizationId === undefined) return null;
  const membership = actor.memberships.find((item) => item.organizationId === organizationId);
  if (!membership) return null;
  return { organizationId, userId: actor.userId, role: membership.role };
}

/** 将 DB row 转为 API 响应（秒级时间戳，不包含 platformToken） */
function toResponse(row: AgentSiteAppRow): AgentSiteApp {
  return {
    id: row.id,
    organizationId: row.organizationId,
    userId: row.userId,
    remoteAppId: row.remoteAppId,
    name: row.name,
    description: row.description ?? null,
    visibility: (row.visibility as AgentSiteApp["visibility"] | undefined) ?? "private",
    appType: (row.appType as AgentSiteApp["appType"] | undefined) ?? "pocketbase",
    entryFile: row.entryFile ?? null,
    activeSlot: (row.activeSlot as AgentSiteApp["activeSlot"] | undefined) ?? null,
    deployedAt: row.deployedAt ? Math.floor(row.deployedAt.getTime() / 1000) : null,
    createdByAgentConfigId: row.createdByAgentConfigId ?? null,
    createdAt: row.createdAt ? Math.floor(new Date(row.createdAt).getTime() / 1000) : 0,
    updatedAt: row.updatedAt ? Math.floor(new Date(row.updatedAt).getTime() / 1000) : 0,
  };
}

/** 判断当前用户是否对 app 有写权限（owner 或 org admin） */
function canWrite(row: { userId: string }, userId: string, role: string): boolean {
  return row.userId === userId || role === "owner" || role === "admin";
}

/**
 * 判断当前用户是否可以在管理界面看到该 app。
 * 管理 API 已是 org 隔离，只需对 private 可见性的 app 做 userId 过滤。
 */
function canRead(row: AgentSiteAppRow, userId: string): boolean {
  if (row.visibility !== "private") return true;
  return row.userId === userId;
}

/** 识别 siteAppId 格式并查找：UUID 格式走 getById，否则走 getByRemoteAppId。
 *  必须区分格式再查，因为 getById 对非 UUID 参数会直接抛 PG 类型异常，不会返回 undefined。 */
async function resolveSiteApp(siteAppId: string) {
  const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(siteAppId);
  return isUuid ? agentSiteAppRepo.getById(siteAppId) : agentSiteAppRepo.getByRemoteAppId(siteAppId);
}

/** 批量解析 createdByAgentConfigId → agent config name，附加到每个 site app 响应对象上。 */
async function attachCreatorNames(items: AgentSiteApp[]): Promise<void> {
  const ids = [...new Set(items.map((i) => i.createdByAgentConfigId).filter((id): id is string => !!id))];
  if (ids.length === 0) return;
  const nameMap = await findAgentConfigNamesByIds(ids);
  for (const item of items) {
    if (item.createdByAgentConfigId) {
      item.createdByAgentConfigName = nameMap.get(item.createdByAgentConfigId) ?? null;
    }
  }
}

/**
 * 构造统一的 /web 错误体，交给 Elysia `status()` 标注状态码。
 */
function buildError(code: string, message: string): WebErr {
  return {
    success: false,
    error: {
      code,
      message,
    },
  };
}

export { attachCreatorNames, buildError, canRead, canWrite, resolveSiteApp, toResponse };
