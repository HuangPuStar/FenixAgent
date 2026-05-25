import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig, agentConfigSkill, mcpServer, provider, skill } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";

// ────────────────────────────────────────────
// 批量配置读取（spawn 时一次性获取 Agent 完整配置）
// ────────────────────────────────────────────

export interface AgentFullConfig {
  agentConfig: typeof agentConfig.$inferSelect | null;
  providers: (typeof provider.$inferSelect)[];
  skills: (typeof skill.$inferSelect)[];
  mcpServers: (typeof mcpServer.$inferSelect)[];
}

/** 获取组织全局技能 */
function listGlobalSkills(orgId: string) {
  return db.select().from(skill).where(eq(skill.organizationId, orgId));
}

export async function getAgentFullConfig(ctx: AuthContext, agentConfigId: string | null): Promise<AgentFullConfig> {
  if (!agentConfigId) {
    const [providers, mcpServers, skills] = await Promise.all([
      db.select().from(provider).where(eq(provider.organizationId, ctx.organizationId)),
      db
        .select()
        .from(mcpServer)
        .where(and(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.enabled, true))),
      listGlobalSkills(ctx.organizationId),
    ]);
    return { agentConfig: null, providers, skills, mcpServers };
  }

  const [providers, mcpServers, acRows, skillBindings] = await Promise.all([
    db.select().from(provider).where(eq(provider.organizationId, ctx.organizationId)),
    db
      .select()
      .from(mcpServer)
      .where(and(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.enabled, true))),
    db
      .select()
      .from(agentConfig)
      .where(and(eq(agentConfig.id, agentConfigId), eq(agentConfig.organizationId, ctx.organizationId)))
      .limit(1),
    db
      .select({ skillId: agentConfigSkill.skillId })
      .from(agentConfigSkill)
      .where(eq(agentConfigSkill.agentConfigId, agentConfigId)),
  ]);

  const [ac] = acRows;

  let skills: (typeof skill.$inferSelect)[] = [];
  if (ac && skillBindings.length > 0) {
    const skillIds = skillBindings.map((b) => b.skillId);
    skills = await db.select().from(skill).where(inArray(skill.id, skillIds));
  }

  return { agentConfig: ac ?? null, providers, skills, mcpServers };
}
