import { agentConfigMcp } from "@server/db/schema";
import { eq } from "drizzle-orm";
import { getMcpDatabase } from "../../db";

/**
 * `@fenix/resource-agent-config` 的 MCP 取数面。
 *
 * 两条内容：`agent_config_mcp` 关联表的数据访问（该表是本包自持的 Agent ↔ MCP 关联边，读写口径由
 * 本包提供，避免第二个包再写一份 delete + insert 覆盖逻辑），以及关联 id 的**展示标签投影**
 * （再导出 `repositories/mcp-server` 的 `findMcpServerLabelsByIds`，消费方拿绑定表给出的 ID 集合换
 * 名称渲染列表）。两者都不是 MCP 资源本体——资源行的授权读写走组合根与 Facade——因此单独出口，
 * 避免消费方为了这两件事导入整个服务端 barrel（barrel 会连带把 HTTP 路由与 agent-runtime 拉进
 * 消费方的依赖图）。DB 句柄在函数内取，不持有模块级连接。
 */

export { findMcpServerLabelsByIds } from "../../repositories/mcp-server";

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
