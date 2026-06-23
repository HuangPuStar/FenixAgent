import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfigSiteApp } from "../../db/schema";

/**
 * Agent ↔ SiteApp 绑定关系服务。
 *
 * 与 agent-config-skill / agent-config-mcp 一致：写入时全量覆盖，
 * 由路由层调用，对外暴露 listAgentSiteAppIds / syncAgentSiteApps 两个原子操作。
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
