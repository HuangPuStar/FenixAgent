import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfigSiteApp } from "../../db/schema";

/**
 * Agent ↔ SiteApp 绑定关系服务。
 *
 * 与 agent-config-skill / agent-config-mcp 一致：写入时全量覆盖，
 * 由路由层调用，对外暴露 listAgentSiteAppIds / syncAgentSiteApps 两个原子操作。
 *
 * chat 右侧 Sites tab 单点挂载/卸载场景额外暴露 addAgentSiteApp / removeAgentSiteApp，
 * 避免单点操作走"读-改-写"全量覆盖带来的并发丢更新风险。
 */
export async function listAgentSiteAppIds(agentConfigId: string): Promise<string[]> {
  const rows = await db
    .select({ siteAppId: agentConfigSiteApp.siteAppId })
    .from(agentConfigSiteApp)
    .where(eq(agentConfigSiteApp.agentConfigId, agentConfigId));
  return rows.map((row) => row.siteAppId);
}

/** 全量覆盖 Agent 的 SiteApp 关联（先删后插）。 */
export async function syncAgentSiteApps(agentConfigId: string, siteAppIds: string[]): Promise<void> {
  await db.delete(agentConfigSiteApp).where(eq(agentConfigSiteApp.agentConfigId, agentConfigId));

  const valid = siteAppIds.filter((id) => id?.trim());
  if (valid.length === 0) return;

  await db.insert(agentConfigSiteApp).values(
    valid.map((siteAppId) => ({
      agentConfigId,
      siteAppId,
    })),
  );
}

/**
 * 绑定单个 SiteApp 到 Agent。
 * 表 PK 为 (agent_config_id, site_app_id) 联合唯一，重复绑定走 ON CONFLICT DO NOTHING 幂等成功。
 * 组织一致性校验由路由层在调用前完成，本函数不做权限判断。
 */
export async function addAgentSiteApp(agentConfigId: string, siteAppId: string): Promise<void> {
  await db.insert(agentConfigSiteApp).values({ agentConfigId, siteAppId }).onConflictDoNothing();
}

/** 解绑单个 SiteApp（不存在时静默成功，DELETE 天然幂等）。 */
export async function removeAgentSiteApp(agentConfigId: string, siteAppId: string): Promise<void> {
  await db
    .delete(agentConfigSiteApp)
    .where(and(eq(agentConfigSiteApp.agentConfigId, agentConfigId), eq(agentConfigSiteApp.siteAppId, siteAppId)));
}
