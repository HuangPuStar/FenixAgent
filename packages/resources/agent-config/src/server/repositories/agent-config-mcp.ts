import { agentConfigMcp } from "@fenix/agent-config/db";
import { eq } from "drizzle-orm";
import { getAgentConfigDatabase } from "../db";

/**
 * Agent ↔ MCP 关联边的持久化访问。
 *
 * 关联表随 Agent 配置聚合根迁入本包（任务 1.7 B7），读写口径因此只有这一处——`agent_config_mcp`
 * 是「这个 Agent 关联了哪些 MCP 服务器」这条边本身，不是 MCP 资源行：资源行的授权读写走 mcp 包的
 * 组合根与 Facade，关联 id 的展示标签由 `@fenix/resource-mcp/server/config` 的
 * `findMcpServerLabelsByIds` 提供（本包只给出 id 集合）。
 *
 * 迁入前它在 mcp 包（`mcp/src/server/services/config/agent-config-mcp.ts`），唯一的调用方是本包的
 * `services/agent-associations.ts`；迁入后 MCP 包不再反向导入本包的表对象，也就不存在
 * `mcp ↔ agent-config` 环。DB 句柄在函数内取，不持有模块级连接。
 */

/** 查询 Agent 关联的所有 mcpServerId。 */
export async function listAgentMcpIds(agentConfigId: string): Promise<string[]> {
  const rows = await getAgentConfigDatabase()
    .select({ mcpServerId: agentConfigMcp.mcpServerId })
    .from(agentConfigMcp)
    .where(eq(agentConfigMcp.agentConfigId, agentConfigId));
  return rows.map((row) => row.mcpServerId);
}

/**
 * 全量覆盖 Agent 的 MCP 关联（先删后插）。
 *
 * 两条语句不包事务：调用点（控制台保存 Agent 配置、`services/agent-bindings.ts`）本身运行在宿主既有
 * 的事务语义之外，引入事务会改变锁范围，超出本次边界收敛的范围；`agent_config_skill` 同形同理。
 */
export async function syncAgentMcps(agentConfigId: string, mcpServerIds: string[]): Promise<void> {
  await getAgentConfigDatabase().delete(agentConfigMcp).where(eq(agentConfigMcp.agentConfigId, agentConfigId));

  // 空串与纯空白是"未选择"，不是有效 id：写入它们会让关联指向不存在的服务器。
  const valid = mcpServerIds.filter((id) => id?.trim());
  if (valid.length === 0) return;

  await getAgentConfigDatabase()
    .insert(agentConfigMcp)
    .values(
      valid.map((mcpServerId) => ({
        agentConfigId,
        mcpServerId,
      })),
    );
}
