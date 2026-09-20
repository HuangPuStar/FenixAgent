import { agentConfigMcp } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { getMcpDatabase } from "../../db";

/**
 * `agent_config_mcp` 关联表的数据访问（MCP 包自持）。
 *
 * 该表是 Agent 配置与 MCP Server 的关联边，被 `@fenix/resource-agent-config` 经
 * `@fenix/resource-mcp/server/config` 消费：读写口径由本包提供，避免第二个包再写一份 delete +
 * insert 覆盖逻辑。DB 句柄在函数内取，不持有模块级连接。
 */

/** 查询 Agent 关联的所有 mcpServerId。 */
export async function listAgentMcpIds(agentConfigId: string): Promise<string[]> {
  const rows = await getMcpDatabase()
    .select({ mcpServerId: agentConfigMcp.mcpServerId })
    .from(agentConfigMcp)
    .where(eq(agentConfigMcp.agentConfigId, agentConfigId));
  return rows.map((row) => row.mcpServerId);
}

/** 全量覆盖 Agent 的 MCP 关联（先删后插）。 */
export async function syncAgentMcps(agentConfigId: string, mcpServerIds: string[]): Promise<void> {
  await getMcpDatabase().delete(agentConfigMcp).where(eq(agentConfigMcp.agentConfigId, agentConfigId));

  const valid = mcpServerIds.filter((id) => id?.trim());
  if (valid.length === 0) return;

  await getMcpDatabase()
    .insert(agentConfigMcp)
    .values(
      valid.map((mcpServerId) => ({
        agentConfigId,
        mcpServerId,
      })),
    );
}
