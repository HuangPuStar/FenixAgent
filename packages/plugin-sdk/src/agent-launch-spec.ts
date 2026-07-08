/**
 * Agent 启动配置规范。
 *
 * Core 在启动前组装它，并在 `prepareEnvironment` 阶段传给 engine 插件。
 * 插件基于这些配置完成环境变量和运行前资源准备。
 */

/**
 * Agent 配置。
 */
export interface AgentConfig {
  name: string;
  prompt?: string;
  /** Agent 配置的 extra JSONB 字段，运行时从这里读取 steps 等参数 */
  extra?: Record<string, unknown> | null;
}

/**
 * Model 配置。
 */
export interface ModelConfig {
  provider: string;
  protocol: "openai" | "anthropic";
  baseUrl: string;
  apiKey: string;
  model: string;
  modelName?: string;
}

/**
 * skill 配置。
 */
export interface SkillConfig {
  name: string;
  /** skill 压缩包下载地址，下载后解压即为 skill 目录。 */
  url: string;
}

/**
 * MCP OAuth 配置。
 */
export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  scope?: string;
  redirectUri?: string;
}

/**
 * MCP stdio 传输配置。
 *
 * 对齐 MCP 官方 stdio transport 语义。
 */
export interface StdioMcpServerConfig {
  name: string;
  type: "stdio";
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * MCP Streamable HTTP 传输配置。
 *
 * 对齐 MCP 官方标准 transport。
 */
export interface StreamableHttpMcpServerConfig {
  name: string;
  type: "streamable-http";
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig | false;
  timeout?: number;
}

/**
 * MCP 服务配置。
 */
export type McpServerConfig = StdioMcpServerConfig | StreamableHttpMcpServerConfig;

/**
 * Agent 启动配置规范。
 */
export interface AgentLaunchSpec {
  organizationId: string;
  userId: string;
  environmentId?: string;
  env?: Record<string, string>;
  agent: AgentConfig;
  model: ModelConfig;
  skills: SkillConfig[];
  mcpServers: McpServerConfig[];
}
