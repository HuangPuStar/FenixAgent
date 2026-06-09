import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfigMcp } from "../../db/schema";

/** 查询 Agent 关联的所有 mcpServerId。 */
export async function listAgentMcpIds(agentConfigId: string): Promise<string[]> {
  const rows = await db
    .select({ mcpServerId: agentConfigMcp.mcpServerId })
    .from(agentConfigMcp)
    .where(eq(agentConfigMcp.agentConfigId, agentConfigId));
  return rows.map((row) => row.mcpServerId);
}

/** 全量覆盖 Agent 的 MCP 关联（先删后插）。 */
export async function syncAgentMcps(agentConfigId: string, mcpServerIds: string[]): Promise<void> {
  await db.delete(agentConfigMcp).where(eq(agentConfigMcp.agentConfigId, agentConfigId));

  const valid = mcpServerIds.filter((id) => id?.trim());
  if (valid.length === 0) return;

  await db.insert(agentConfigMcp).values(
    valid.map((mcpServerId) => ({
      agentConfigId,
      mcpServerId,
    })),
  );
}
