import { agentConfig } from "@server/db/schema";
import { inArray } from "drizzle-orm";
import { getAgentConfigDatabase } from "../db";

/**
 * Agent 配置的只读查询（资源行主表本身见 `agent-config-resource.ts`）。
 *
 * CE 1.4 W4 已删除本文件原有的「扁平聚合读取」（`PgAgentConfigRepo`，为编排域的扁平
 * LaunchSpec 供数）：启动参数组装改由 `services/agent-launch-spec/` 按领域解析，
 * 不需要一份把 skills / mcpServers / knowledgeBases 拍平的中间视图。
 */

/**
 * 按配置 ID 批量查询展示名称（Observer 面板 name(id) 展示用，只读）。
 * 空入参返回空 Map，避免生成空 IN 子句。
 */
export async function findAgentConfigNamesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = getAgentConfigDatabase();
  const rows = await db
    .select({ id: agentConfig.id, name: agentConfig.name })
    .from(agentConfig)
    .where(inArray(agentConfig.id, ids));
  return new Map(rows.map((row) => [row.id, row.name]));
}
