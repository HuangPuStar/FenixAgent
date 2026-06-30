/**
 * mcp.ts — MCP 服务器配置域 API 模块
 *
 * 封装 MCP 服务器的 CRUD、启停、检测等操作。
 * 后端使用 POST /web/config/mcp 的 action 分发模式，域模块内部抽象为具名方法。
 */

import type { McpInspectResult, McpServerConfig, McpServerInfo, McpToolInfo } from "../../src/types/config";
import { request } from "./request";

/** 列表响应：后端在 data.servers 中返回服务器数组 */
interface McpListResult {
  servers: McpServerInfo[];
}

/** 读取详情响应 */
interface McpGetResult {
  name: string;
  config: McpServerConfig;
  resourceAccess?: McpServerInfo["resourceAccess"];
}

/** 创建/更新响应 */
interface McpSaveResult {
  name: string;
}

/** 启停响应 */
interface McpToggleResult {
  name: string;
  enabled: boolean;
}

/** test/test_url 响应 */
interface McpTestResult {
  name?: string;
  reachable: boolean;
  protocol?: boolean;
  serverName?: string | null;
  serverVersion?: string | null;
  toolsCount?: number;
  transport?: string;
  message?: string;
}

/** list_tools 响应 */
interface McpListToolsResult {
  name: string;
  tools: McpToolInfo[];
}

export const mcpApi = {
  /** 获取 MCP 服务器列表 */
  list: () => request<McpListResult>("/web/config/mcp", { method: "POST", body: { action: "list" } }),

  /** 获取单个 MCP 服务器详情 */
  get: (name: string) => request<McpGetResult>("/web/config/mcp", { method: "POST", body: { action: "get", name } }),

  /** 创建 MCP 服务器 */
  create: (name: string, config: McpServerConfig) =>
    request<McpSaveResult>("/web/config/mcp", { method: "POST", body: { action: "create", name, config } }),

  /** 更新 MCP 服务器配置 */
  update: (name: string, config: McpServerConfig) =>
    request<McpSaveResult>("/web/config/mcp", { method: "POST", body: { action: "set", name, config } }),

  /** 删除 MCP 服务器 */
  del: (name: string) => request<void>("/web/config/mcp", { method: "POST", body: { action: "delete", name } }),

  /** 启用 MCP 服务器 */
  enable: (name: string) =>
    request<McpToggleResult>("/web/config/mcp", { method: "POST", body: { action: "enable", name } }),

  /** 禁用 MCP 服务器 */
  disable: (name: string) =>
    request<McpToggleResult>("/web/config/mcp", { method: "POST", body: { action: "disable", name } }),

  /** 测试已保存的 MCP 服务器连接 */
  test: (name: string) => request<McpTestResult>("/web/config/mcp", { method: "POST", body: { action: "test", name } }),

  /** 测试 URL 是否可达且支持 MCP 协议 */
  testUrl: (url: string, headers?: Record<string, string>, timeout?: number) =>
    request<McpTestResult>("/web/config/mcp", {
      method: "POST",
      body: { action: "test_url", url, headers, timeout },
    }),

  /** 检测远程 MCP 服务器并同步工具列表（仅 writable 的 server） */
  inspect: (name: string) =>
    request<McpInspectResult>("/web/config/mcp", { method: "POST", body: { action: "inspect", name } }),

  /** 获取缓存的工具列表（用于外部只读 MCP server） */
  listTools: (name: string) =>
    request<McpListToolsResult>("/web/config/mcp", { method: "POST", body: { action: "list_tools", name } }),
};
