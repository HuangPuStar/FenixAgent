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
  modalities?: { input?: ("text" | "image")[]; output?: ("text" | "image")[] } | string[];
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

/** 平台托管的工作区 JSON 文件 DTO；仅含可序列化数据，不携带领域服务或宿主绝对路径。 */
export interface WorkspaceFile {
  /** 工作区内相对路径；执行端校验禁止越界与符号链接。 */
  path: string;
  /** 完整 JSON 内容，每次 prepare 全量替换；可能含凭据，禁止记录到日志。 */
  content: Record<string, unknown>;
  /** 只传递该文件绝对位置的环境变量名，由统一物化边界重定位。 */
  envVar?: string;
}

/**
 * Agent 启动配置规范。
 */
export interface AgentLaunchSpec {
  organizationId: string;
  userId: string;
  environmentId?: string;
  env?: Record<string, string>;
  /** 引擎无关的插件能力标识；具体 npm 名/市场别名由引擎适配。 */
  plugins?: "hindsight"[];
  workspaceFiles?: WorkspaceFile[];
  agent: AgentConfig;
  model: ModelConfig;
  skills: SkillConfig[];
  mcpServers: McpServerConfig[];
}
