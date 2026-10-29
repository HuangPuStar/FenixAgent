import type * as acp from "@agentclientprotocol/sdk";

/**
 * 只保留平台支持的 HTTP MCP 条目。
 *
 * 平台只经 ACP 下发 `im` 这类 HTTP server；relay 客户端可自带 `mcpServers`，若放行 stdio，
 * 等于允许它让 Agent 在本机启动任意进程（规格 §4.4）。
 */
export function readPlatformMcpServers(value: unknown): acp.McpServer[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is acp.McpServer => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { type?: unknown; name?: unknown; url?: unknown };
    return candidate.type === "http" && typeof candidate.name === "string" && typeof candidate.url === "string";
  });
}
