import type { ApiSystemUserRecord } from "@fenix/platform-sdk";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import {
  type ModelGatewaySubjectAgent,
  type SubjectSearchInput,
  searchAgentConfigs,
} from "../repositories/subject-agent-search";

/**
 * 管理端主体检索：用户走身份目录，Agent 走本包仓储的只读投影。
 *
 * 本文件不接触 DB 句柄：1.3 要求 repository 是包内唯一数据访问点，Agent 检索的 SQL 已在
 * `../repositories/subject-agent-search`，这里只做分页适配与依赖装配（测试可整体替换两个检索函数）。
 */

export type { ModelGatewaySubjectAgent, SubjectSearchInput } from "../repositories/subject-agent-search";

export interface ModelGatewaySubjectServiceDeps {
  findUsers: (input: SubjectSearchInput) => Promise<ApiSystemUserRecord[]>;
  listAgents: (input: SubjectSearchInput) => Promise<ModelGatewaySubjectAgent[]>;
}

/**
 * 用户检索经 `IdentityDirectory`：身份表读取的唯一合法落点，本包不得再直查 `user` / `member`。
 *
 * 这里返回的是 `/api/system/*` 的完整用户记录（含 `emailVerified` / 手机号等账号状态字段），
 * 只有系统管理面需要这些字段。
 */
async function searchUsersViaDirectory(input: SubjectSearchInput): Promise<ApiSystemUserRecord[]> {
  return [...(await getIdentityDirectory().searchUsers(input))];
}

/** 管理端主体选择器：用户来自系统全局，Agent 来自全局 Agent 配置表。 */
export function createModelGatewaySubjectService(deps: Partial<ModelGatewaySubjectServiceDeps> = {}) {
  const resolved = {
    findUsers: deps.findUsers ?? searchUsersViaDirectory,
    listAgents: deps.listAgents ?? searchAgentConfigs,
  };
  return {
    async searchUsers(input: SubjectSearchInput): Promise<{
      items: ApiSystemUserRecord[];
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
