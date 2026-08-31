import { and, ilike, or } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig } from "../../db/schema";
import { findModelGatewayUsers } from "../../repositories/model-gateway-subject";
import type { SystemApiPagination, SystemApiUserRecord } from "../system-api";

export interface ModelGatewaySubjectAgent {
  id: string;
  name: string;
  organizationId: string;
  userId: string;
}

export interface SubjectSearchInput extends SystemApiPagination {
  keyword?: string;
  organizationId?: string;
  userId?: string;
}

export interface ModelGatewaySubjectServiceDeps {
  findUsers: (input: SubjectSearchInput) => Promise<SystemApiUserRecord[]>;
  listAgents: (input: SubjectSearchInput) => Promise<ModelGatewaySubjectAgent[]>;
}

async function queryAgents(input: SubjectSearchInput): Promise<ModelGatewaySubjectAgent[]> {
  const conditions = [];
  if (input.organizationId) conditions.push(ilike(agentConfig.organizationId, input.organizationId));
  if (input.userId) conditions.push(ilike(agentConfig.userId, input.userId));
  if (input.keyword?.trim()) {
    const keyword = `%${input.keyword.trim()}%`;
    conditions.push(or(ilike(agentConfig.name, keyword), ilike(agentConfig.id, keyword)));
  }
  const rows = await db
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

/** 管理端主体选择器：用户来自系统全局，Agent 来自全局 Agent 配置表。 */
export function createModelGatewaySubjectService(deps: Partial<ModelGatewaySubjectServiceDeps> = {}) {
  const resolved = {
    findUsers: deps.findUsers ?? findModelGatewayUsers,
    listAgents: deps.listAgents ?? queryAgents,
  };
  return {
    async searchUsers(input: SubjectSearchInput): Promise<{
      items: SystemApiUserRecord[];
      total: number;
      page: number;
      pageSize: number;
    }> {
      const users = await resolved.findUsers(input);
      return {
        items: users.slice((input.page - 1) * input.pageSize, input.page * input.pageSize),
        total: users.length,
        page: input.page,
        pageSize: input.pageSize,
      };
    },
    /** 预算状态依赖 LiteLLM，需先取得所有已按 Fenix 条件筛出的候选用户。 */
    findUsers(input: SubjectSearchInput) {
      return resolved.findUsers(input);
    },
    searchAgents(input: SubjectSearchInput) {
      return resolved.listAgents(input);
    },
  };
}
