import type { ApiSystemPagination } from "@fenix/platform-sdk";
import { agentConfig } from "@server/db/schema";
import { and, ilike, or } from "drizzle-orm";
import { getModelManagementDatabase } from "../db";

/**
 * 模型网关预算主体选择器的 Agent 检索（只读）。
 *
 * 这是 `/api/system/model-gateway/*` 系统管理面的投影：按组织 / 用户 / 关键字在**全局** `agent_config`
 * 上分页检索，没有调用主体，因此不走授权查询（授权入口是 `@fenix/agent-config` 的 Facade，它需要
 * `access` 条件与 actor）。
 *
 * 边界残留（1.3 保留，见 README「边界残留」）：表归 `@fenix/agent-config`，而它的 `./server` 入口今天
 * 只提供受控 `list`（需要 actor 与 `ResourceQueryConstraint`）与按 ID / 名称的定位函数，没有全局分页
 * 检索。移除条件：对方在 `./server` 暴露全局检索后，本文件退化为它的薄适配层或直接删除。在此之前的
 * 读是**只读投影**，不写对方表，也不复制对方的领域规则（过滤条件仅按列匹配）。
 */
export interface ModelGatewaySubjectAgent {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
}

/** 检索条件与分页；查询串由路由解析后传入，本层不做协议转换。 */
export interface SubjectSearchInput extends ApiSystemPagination {
  keyword?: string;
  organizationId?: string;
  userId?: string;
}

/** 按条件分页检索 Agent 配置；无条件时返回全表第一页（系统管理面的预期行为）。 */
export async function searchAgentConfigs(input: SubjectSearchInput): Promise<ModelGatewaySubjectAgent[]> {
  const conditions = [];
  if (input.organizationId) conditions.push(ilike(agentConfig.organizationId, input.organizationId));
  if (input.userId) conditions.push(ilike(agentConfig.userId, input.userId));
  if (input.keyword?.trim()) {
    const keyword = `%${input.keyword.trim()}%`;
    conditions.push(or(ilike(agentConfig.name, keyword), ilike(agentConfig.id, keyword)));
  }
  const rows = await getModelManagementDatabase()
    .select({
      id: agentConfig.id,
      name: agentConfig.name,
      organizationId: agentConfig.organizationId,
      userId: agentConfig.userId,
    })
    .from(agentConfig)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);
  return rows;
}
