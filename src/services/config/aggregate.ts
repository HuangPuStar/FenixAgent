import { db } from "../../db";
import { agentConfig, provider, skill, mcpServer } from "../../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

// ────────────────────────────────────────────
// 批量配置读取（spawn 时一次性获取 Agent 完整配置）
// ────────────────────────────────────────────

export interface AgentFullConfig {
  agentConfig: typeof agentConfig.$inferSelect | null;
  providers: (typeof provider.$inferSelect)[];
  skills: (typeof skill.$inferSelect)[];
  mcpServers: (typeof mcpServer.$inferSelect)[];
}

export async function getAgentFullConfig(userId: string, agentConfigId: string): Promise<AgentFullConfig> {
  const [ac] = await db.select().from(agentConfig)
    .where(and(eq(agentConfig.id, agentConfigId), eq(agentConfig.userId, userId)))
    .limit(1);

  if (!ac) {
    return { agentConfig: null, providers: [], skills: [], mcpServers: [] };
  }

  const [providers, skills, mcpServers] = await Promise.all([
    db.select().from(provider).where(eq(provider.userId, userId)),
    db.select().from(skill).where(and(
      eq(skill.userId, userId),
      isNull(skill.environmentId),
      sql`(${skill.agentConfigId} IS NULL OR ${skill.agentConfigId} = ${agentConfigId})`,
    )),
    db.select().from(mcpServer).where(and(eq(mcpServer.userId, userId), eq(mcpServer.enabled, true))),
  ]);

  return { agentConfig: ac, providers, skills, mcpServers };
}
