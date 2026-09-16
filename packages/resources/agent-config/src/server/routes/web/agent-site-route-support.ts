import { inArray } from "drizzle-orm";
import { db } from "../../../../../../../apps/server/src/db";
import { agentConfig } from "../../../../../../../apps/server/src/db/schema";
import type { WebErr } from "../../../../../../../src/schemas/common.schema";
import type { AgentSiteAppRow } from "../../repositories/agent-site-app";
import { agentSiteAppRepo } from "../../repositories/agent-site-app";
import type { AgentSiteApp } from "../../schemas/agent-site.schema";

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
  const rows = await db
    .select({ id: agentConfig.id, name: agentConfig.name })
    .from(agentConfig)
    .where(inArray(agentConfig.id, ids));
  const nameMap = new Map(rows.map((r) => [r.id, r.name]));
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
