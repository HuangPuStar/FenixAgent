/**
 * mcp.ts — MCP 服务器配置域 API 模块
 *
 * 封装 MCP 服务器的 CRUD、启停、检测等操作。
 * 后端使用 REST 风格端点（GET/POST/PATCH/DELETE /web/config/mcp，单资源使用 ID 路径），
 * 域模块内部抽象为具名方法。
 */

import { request } from "@fenix/web-runtime/api/request";
import type {
  McpInspectResult,
  McpServerConfig,
  McpServerDetail,
  McpServerInfo,
  McpToolInfo,
} from "@fenix/web-runtime/types/config";

/** 列表响应：后端在 data.servers 中返回服务器数组 */
interface McpListResult {
  servers: McpServerInfo[];
}

/** 读取详情响应：仅返回完整配置与授权视图（`scope` / `access`），不含列表专有的展示字段。 */
type McpGetResult = McpServerDetail;

/** 创建/更新响应 */
interface McpSaveResult {
  id: string;
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
  list: () => request<McpListResult>("/web/config/mcp", { method: "GET" }),

  /** 获取单个 MCP 服务器详情 */
  get: (name: string) => request<McpGetResult>("/web/config/mcp/:id", { method: "GET", params: { id: name } }),

  /** 创建 MCP 服务器 */
  create: (name: string, config: McpServerConfig) =>
    request<McpSaveResult>("/web/config/mcp", { method: "POST", body: { name, config } }),

  /** 更新 MCP 服务器配置 */
  update: (name: string, config: McpServerConfig) =>
    request<McpSaveResult>("/web/config/mcp/:id", { method: "PATCH", params: { id: name }, body: { config } }),

  /** 删除 MCP 服务器 */
  del: (name: string) => request<void>("/web/config/mcp/:id", { method: "DELETE", params: { id: name } }),

  /** 启用 MCP 服务器 */
  enable: (name: string) =>
    request<McpToggleResult>("/web/config/mcp/:id", { method: "PATCH", params: { id: name }, body: { enabled: true } }),

  /** 禁用 MCP 服务器 */
  disable: (name: string) =>
    request<McpToggleResult>("/web/config/mcp/:id", {
      method: "PATCH",
      params: { id: name },
      body: { enabled: false },
    }),

  /** 测试已保存的 MCP 服务器连接 */
  test: (name: string) => request<McpTestResult>("/web/config/mcp/:id/test", { method: "POST", params: { id: name } }),

  /** 测试 URL 是否可达且支持 MCP 协议 */
  testUrl: (url: string, headers?: Record<string, string>, timeout?: number) =>
    request<McpTestResult>("/web/config/mcp/test-url", {
      method: "POST",
      body: { url, headers, timeout },
    }),

  /** 检测远程 MCP 服务器并同步工具列表（仅 writable 的 server） */
  inspect: (name: string) =>
    request<McpInspectResult>("/web/config/mcp/:id/inspect", { method: "POST", params: { id: name } }),

  /** 获取缓存的工具列表（用于外部只读 MCP server） */
  listTools: (name: string) =>
    request<McpListToolsResult>("/web/config/mcp/:id/tools", { method: "GET", params: { id: name } }),
};
