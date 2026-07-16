import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentMemoryConfig } from "../db/schema";

export type AgentMemoryConfig = typeof agentMemoryConfig.$inferSelect;

/** 按 agentConfigId 查询记忆配置（不存在返回 null = 未启用） */
export async function getByAgentConfigId(agentConfigId: string): Promise<AgentMemoryConfig | null> {
  const rows = await db
    .select()
    .from(agentMemoryConfig)
    .where(eq(agentMemoryConfig.agentConfigId, agentConfigId))
    .limit(1);
  return rows[0] ?? null;
}

/** 设置记忆启用状态（upsert：有则更新 enabled + updatedAt，无则创建） */
export async function setEnabled(agentConfigId: string, enabled: boolean): Promise<AgentMemoryConfig> {
  const existing = await getByAgentConfigId(agentConfigId);
  if (existing) {
    const [updated] = await db
      .update(agentMemoryConfig)
      .set({ enabled, updatedAt: new Date() })
      .where(eq(agentMemoryConfig.agentConfigId, agentConfigId))
      .returning();
    return updated;
  }
  const [created] = await db.insert(agentMemoryConfig).values({ agentConfigId, enabled }).returning();
  return created;
}
