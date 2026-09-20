/**
 * agents.ts — Agent 配置域 API 模块
 *
 * 封装 Agent 配置的 CRUD、模板查询、默认值设置等操作。
 * 后端使用标准 REST 端点（GET/POST/PUT/DELETE），域模块内部抽象为具名方法。
 */

import { request } from "@fenix/web-runtime/api/request";
import type { AgentDetail, AgentInfo, ResourceAccessView } from "@fenix/web-runtime/types/config";

/** Agent 模板 */
interface AgentTemplate {
  id: string;
  name: string;
  description: string;
  prompt: string;
  skills: string[];
}

/** 模板列表响应 */
interface AgentTemplatesResult {
  templates: AgentTemplate[];
}

/** Agent 列表响应：后端在 data 中返回 default_agent + agents 数组 */
interface AgentListResult {
  default_agent: string | null;
  agents: AgentInfo[];
}

/**
 * 创建/更新响应：与后端 `toSaveResult`（`src/server/routes/web/config/agent-route-support.ts`）
 * 的返回一一对应——名称、资源 id 与授权视图字段（`scope` + `access`）恒返回，供保存后立即更新界面状态。
 *
 * 授权视图字段声明为**必填**：写路径的返回不经过部分响应或旧缓存，缺字段只可能是契约漂移，
 * 按可选声明会让消费点把「后端改了字段名」误读成「本地保守降级」。
 */
interface AgentSaveResult extends ResourceAccessView {
  id: string;
  name: string;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
}

/** 设置默认 Agent 响应：与后端 `handleSetDefault` 的返回一一对应（个人资源没有归属组织可展示）。 */
interface AgentSetDefaultResult extends ResourceAccessView {
  default_agent: string;
  /** 归属组织展示名；身份名录不可用时后端整字段省略。 */
  organizationName?: string;
}

interface AgentRestartResult {
  environmentIds: string[];
  restartedInstanceIds: string[];
}

/** 删除响应：后端返回 data: null */
type AgentDeleteResult = null;

export const agentApi = {
  /** 获取 Agent 模板列表 */
  templates: () => request<AgentTemplatesResult>("/web/config/agents/templates", { method: "GET" }),

  /** 获取 Agent 列表，包含默认 Agent 信息和关联资源标签 */
  list: () => request<AgentListResult>("/web/config/agents", { method: "GET" }),

  /** 获取单个 Agent 详情，包含 skill、MCP、知识库和 site 关联信息 */
  get: (name: string) => request<AgentDetail>("/web/config/agents", { method: "GET", query: { name } }),

  /** 更新 Agent 配置，并同步知识库、Skill 与 MCP 关联 */
  set: (name: string, data: Record<string, unknown>) =>
    request<AgentSaveResult>("/web/config/agents", { method: "PUT", query: { name }, body: { data } }),

  /** 创建新的 Agent 配置 */
  create: (name: string, data: Record<string, unknown>) =>
    request<AgentSaveResult>("/web/config/agents", { method: "POST", body: { name, data } }),

  /** 使用最新配置重启该 Agent 绑定 Environment 下的活跃 runtime，保留持久 Instance。 */
  restart: (name: string) =>
    request<AgentRestartResult>("/web/config/agents/restart", { method: "POST", query: { name } }),

  /** 删除 Agent 配置（内置 Agent 不可删除） */
  del: (name: string) => request<AgentDeleteResult>("/web/config/agents", { method: "DELETE", query: { name } }),

  /** 删除 Agent 配置（别名，兼容 sidebark 等仍使用 .delete() 的调用方） */
  delete: (name: string) => request<AgentDeleteResult>("/web/config/agents", { method: "DELETE", query: { name } }),

  /** 将指定 Agent 设为当前用户的默认 Agent */
  setDefault: (name: string) =>
    request<AgentSetDefaultResult>("/web/config/agents/default", { method: "POST", body: { name } }),
};
