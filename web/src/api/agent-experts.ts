/**
 * agent-experts.ts — 专家库（agent_expert）配置域 API 模块
 *
 * 封装专家库的 action 风格接口（POST /web/config/agent-expert）：
 * list/create/update/delete/refresh/duplicate。所有操作返回 unwrap 后的 data 载荷。
 */

import type { AgentExpert } from "../types/config";
import { request } from "./request";

/** list 响应：当前组织可见的专家列表（内置 + 本组织） */
interface AgentExpertListResult {
  experts: AgentExpert[];
}

/** create/update/duplicate 响应：操作后的专家完整视图 */
interface AgentExpertMutationResult {
  expert: AgentExpert;
}

/** refresh 响应 */
interface AgentExpertRefreshResult {
  refreshed: boolean;
}

export const agentExpertApi = {
  /** 获取专家列表（内置 + 本组织；默认排除 disabled，includeDisabled=true 时包含） */
  list: (includeDisabled = false) =>
    request<AgentExpertListResult>("/web/config/agent-expert", {
      method: "POST",
      body: { action: "list", includeDisabled },
    }),

  /** 创建组织自建专家 */
  create: (data: Record<string, unknown>) =>
    request<AgentExpertMutationResult>("/web/config/agent-expert", {
      method: "POST",
      body: { action: "create", data },
    }),

  /** 更新组织自建专家（system 内置行会被拒绝 FORBIDDEN） */
  update: (id: string, data: Record<string, unknown>) =>
    request<AgentExpertMutationResult>("/web/config/agent-expert", {
      method: "POST",
      body: { action: "update", name: id, data },
    }),

  /** 删除组织自建专家（system 内置行会被拒绝；内置软删除仅由模板同步管理） */
  del: (id: string) =>
    request<null>("/web/config/agent-expert", { method: "POST", body: { action: "delete", name: id } }),

  /** 复制专家到本组织（内置专家禁用后的恢复路径，重名自动 -copy 后缀） */
  duplicate: (id: string) =>
    request<AgentExpertMutationResult>("/web/config/agent-expert", {
      method: "POST",
      body: { action: "duplicate", name: id },
    }),

  /** 手动触发内置模板同步（幂等，失败仅服务端告警） */
  refresh: () =>
    request<AgentExpertRefreshResult>("/web/config/agent-expert", { method: "POST", body: { action: "refresh" } }),
};
