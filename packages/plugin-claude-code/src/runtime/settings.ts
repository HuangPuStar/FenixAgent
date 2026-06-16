import type { AgentLaunchSpec, McpServerConfig } from "@fenix/plugin-sdk";

export interface InstalledSkillReference {
  name: string;
  path: string;
}

/**
 * Claude Code 的 settings.local.json 格式。
 * 写入 workspace 下 .claude/settings.local.json。
 */
export interface ClaudeCodeSettings {
  env?: Record<string, string>;
  model?: string;
  modelType?: string;
  permissions?: {
    allow?: string[];
    deny?: string[];
    defaultMode?: string;
  };
}

/**
 * Claude Code 的 .mcp.json 格式。
 * 写入 workspace 根目录 .mcp.json。
 */
export interface ClaudeCodeMcpConfig {
  mcpServers: Record<string, ClaudeCodeMcpServerConfig>;
}

export interface ClaudeCodeMcpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ClaudeCodeMcpRemoteConfig {
  url: string;
  headers?: Record<string, string>;
}

export type ClaudeCodeMcpServerConfig = ClaudeCodeMcpStdioConfig | ClaudeCodeMcpRemoteConfig;

function isStreamableHttp(server: McpServerConfig): server is Extract<McpServerConfig, { type: "streamable-http" }> {
  return server.type === "streamable-http";
}

/**
 * 把 AgentLaunchSpec.mcpServers 转为 .mcp.json 格式。
 */
export function buildMcpConfig(launchSpec: AgentLaunchSpec): ClaudeCodeMcpConfig | null {
  if (launchSpec.mcpServers.length === 0) return null;

  const mcpServers: Record<string, ClaudeCodeMcpServerConfig> = {};
  for (const server of launchSpec.mcpServers) {
    if (isStreamableHttp(server)) {
      mcpServers[server.name] = {
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    } else {
      mcpServers[server.name] = {
        command: server.command,
        ...(server.args ? { args: server.args } : {}),
        ...(server.env ? { env: server.env } : {}),
        ...(server.cwd ? { cwd: server.cwd } : {}),
      };
    }
  }

  return { mcpServers };
}

/**
 * 把 AgentLaunchSpec 转为 Claude Code settings.local.json 配置。
 */
export function buildSettings(
  launchSpec: AgentLaunchSpec,
  _installedSkills: InstalledSkillReference[],
): ClaudeCodeSettings {
  const config: ClaudeCodeSettings = {};

  // 环境变量：注入 model 的 apiKey / baseUrl
  const env: Record<string, string> = {};
  const { model } = launchSpec;

  if (model.apiKey && !model.apiKey.startsWith("{env:")) {
    // 非占位符的明文 key 直接使用
    if (model.protocol === "anthropic") {
      env.ANTHROPIC_API_KEY = model.apiKey;
      if (model.baseUrl) env.ANTHROPIC_BASE_URL = model.baseUrl;
    } else {
      env.OPENAI_API_KEY = model.apiKey;
      if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }
  }
  // 如果 machine 环境已经有 ANTHROPIC_API_KEY（如 docker-compose 注入），
  // 且 model.apiKey 是占位符，则优先使用 machine 的环境变量
  if (!env.ANTHROPIC_API_KEY && process.env.ANTHROPIC_API_KEY && model.protocol === "anthropic") {
    env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    if (model.baseUrl && model.baseUrl.startsWith("http")) env.ANTHROPIC_BASE_URL = model.baseUrl;
    else if (process.env.ANTHROPIC_BASE_URL) env.ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL;
  }

  if (model.modelName) {
    env.ANTHROPIC_MODEL = model.modelName;
  }

  // 额外环境变量
  if (launchSpec.env) {
    Object.assign(env, launchSpec.env);
  }

  if (Object.keys(env).length > 0) {
    config.env = env;
  }

  // model 字段
  if (model.modelName) {
    config.model = model.modelName;
  }

  return config;
}
