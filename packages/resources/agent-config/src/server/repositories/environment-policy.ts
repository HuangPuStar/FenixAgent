import { agentEnvironmentPolicy } from "@fenix/agent-config/db";
import { eq } from "drizzle-orm";
import { getAgentConfigDatabase } from "../db";
/** 按 AgentConfig 聚合读取可选 TTL 策略，不承担授权。 */
export async function getAgentEnvironmentTtl(agentConfigId: string): Promise<number | null> {
  const [row] = await getAgentConfigDatabase()
    .select()
    .from(agentEnvironmentPolicy)
    .where(eq(agentEnvironmentPolicy.agentConfigId, agentConfigId))
    .limit(1);
  return row?.ttlSeconds ?? null;
}
/** 原子替换策略，时间戳只在提交成功后可见。 */
export async function putAgentEnvironmentTtl(agentConfigId: string, ttlSeconds: number): Promise<void> {
  await getAgentConfigDatabase()
    .insert(agentEnvironmentPolicy)
    .values({ agentConfigId, ttlSeconds })
    .onConflictDoUpdate({ target: agentEnvironmentPolicy.agentConfigId, set: { ttlSeconds, updatedAt: new Date() } });
}
/** 删除覆盖后回到默认 TTL。 */
export async function deleteAgentEnvironmentTtl(agentConfigId: string): Promise<void> {
  await getAgentConfigDatabase()
    .delete(agentEnvironmentPolicy)
    .where(eq(agentEnvironmentPolicy.agentConfigId, agentConfigId));
}
