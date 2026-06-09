/** Claude SDK MCP server 配置格式 */
export interface SdkMcpServerConfig {
  type: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

/** DB 中的 MCP server 配置 */
export interface McpServerConfig {
  name: string;
  type: string;
  command?: string[];
  args?: string[];
  environment?: Record<string, string>;
  url?: string;
}

/**
 * DB MCP 配置 → Claude SDK MCP 格式转换：
 *   stdio → { type: "stdio", command, args, env }
 *   streamable-http → { type: "sse", url }
 */
export function mapMcpServersToSdkFormat(mcpServers: McpServerConfig[]): Record<string, SdkMcpServerConfig> {
  const result: Record<string, SdkMcpServerConfig> = {};
  for (const server of mcpServers) {
    if (server.type === "local" && server.command) {
      result[server.name] = {
        type: "stdio",
        command: server.command[0],
        args: server.command.slice(1),
        env: server.environment,
      };
    } else if ((server.type === "remote" || server.type === "streamable-http") && server.url) {
      result[server.name] = { type: "sse", url: server.url };
    }
  }
  return result;
}
