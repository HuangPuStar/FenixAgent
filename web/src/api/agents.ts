/**
 * agents.ts — Agent 配置域 API 模块
 *
 * 封装 Agent 配置的 CRUD、模板查询、默认值设置等操作。
 * 后端使用标准 REST 端点（GET/POST/PUT/DELETE），域模块内部抽象为具名方法。
 */

import type { AgentDetail, AgentInfo } from "../../src/types/config";
import { request } from "./request";

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

/** 创建/更新响应 */
interface AgentSaveResult {
  name: string;
  id?: string;
  resourceAccess?: unknown;
}

/** 设置默认 Agent 响应 */
interface AgentSetDefaultResult {
  default_agent: string;
  resourceAccess?: unknown;
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

  /** 删除 Agent 配置（内置 Agent 不可删除） */
  del: (name: string) => request<AgentDeleteResult>("/web/config/agents", { method: "DELETE", query: { name } }),

  /** 删除 Agent 配置（别名，兼容 sidebark 等仍使用 .delete() 的调用方） */
  delete: (name: string) => request<AgentDeleteResult>("/web/config/agents", { method: "DELETE", query: { name } }),

  /** 将指定 Agent 设为当前用户的默认 Agent */
  setDefault: (name: string) =>
    request<AgentSetDefaultResult>("/web/config/agents/default", { method: "POST", body: { name } }),
};
