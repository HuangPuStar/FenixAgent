import { agentMemoryConfig } from "@fenix/resource-memory/db";
import { eq } from "drizzle-orm";
import { getMemoryDatabase } from "../db";

/**
 * Agent 记忆开关的唯一数据访问点。
 *
 * 句柄经 `getMemoryDatabase()`（= 平台契约的 `getDatabase()`）获取，不 import 宿主 `@server/db`：
 * 包离开宿主后仍可测试（包内用例 stub DB），宿主也能替换连接实现而不影响本包。
 *
 * 表对象自 §1.7 B10 起由本包 `db/schema.ts` 持有（`@fenix/resource-memory/db` 自引用而非相对路径：
 * `db/` 不进 `tsconfig.json` 的 `include`，走包 `exports` 才能被解析）。本包至此对宿主已零内部导入，
 * 台账 `apps-boundary` 的条目随之删除。
 */

export type AgentMemoryConfig = typeof agentMemoryConfig.$inferSelect;

/** 按 agentConfigId 查询记忆配置（不存在返回 null = 未启用） */
export async function getByAgentConfigId(agentConfigId: string): Promise<AgentMemoryConfig | null> {
  const db = getMemoryDatabase();
  const rows = await db
    .select()
    .from(agentMemoryConfig)
    .where(eq(agentMemoryConfig.agentConfigId, agentConfigId))
    .limit(1);
  return rows[0] ?? null;
}

/** 设置记忆启用状态（upsert：有则更新 enabled + updatedAt，无则创建） */
export async function setEnabled(agentConfigId: string, enabled: boolean): Promise<AgentMemoryConfig> {
  const db = getMemoryDatabase();
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
