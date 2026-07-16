import type { AgentLaunchSpec, McpServerConfig } from "@fenix/plugin-sdk";

export interface InstalledSkillReference {
  name: string;
  path: string;
}

/**
 * Claude Code 的 settings.local.json 格式。
 * 写入 workspace 下 .claude/settings.local.json。
 */
export interface CcbRuntimeConfig {
  env?: Record<string, string>;
  model?: string;
  modelType?: string;
  poorMode?: boolean;
  enabledPlugins?: Record<string, boolean>;
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
export interface CcbMcpConfig {
  mcpServers: Record<string, CcbMcpServerConfig>;
}

export interface CcbMcpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface CcbMcpRemoteConfig {
  url: string;
  headers?: Record<string, string>;
}

export type CcbMcpServerConfig = CcbMcpStdioConfig | CcbMcpRemoteConfig;

function isStreamableHttp(server: McpServerConfig): server is Extract<McpServerConfig, { type: "streamable-http" }> {
  return server.type === "streamable-http";
}

/**
 * 把 AgentLaunchSpec.mcpServers 转为 .mcp.json 格式。
 */
export function buildCcbMcpConfig(launchSpec: AgentLaunchSpec): CcbMcpConfig | null {
  if (launchSpec.mcpServers.length === 0) return null;

  const mcpServers: Record<string, CcbMcpServerConfig> = {};
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
 * 把 AgentLaunchSpec 转为 Claude Code settings.json 配置。
 */
export function buildCcbRuntimeConfig(
  launchSpec: AgentLaunchSpec,
  _installedSkills: InstalledSkillReference[],
): CcbRuntimeConfig {
  const config: CcbRuntimeConfig = {};

  // 环境变量：注入 model 的 apiKey / baseUrl
  const env: Record<string, string> = {};
  const { model } = launchSpec;
  // 对齐 opencode：优先用 modelName，fallback 到 model
  const effectiveModelName = model.modelName ?? model.model;

  if (model.apiKey) {
    // claude 使用 ANTHROPIC_AUTH_TOKEN 或 OPENAI_API_KEY
    if (model.protocol === "anthropic") {
      env.ANTHROPIC_AUTH_TOKEN = model.apiKey;
      // CCB 同时读取 ANTHROPIC_API_KEY，多写一份确保兼容
      env.ANTHROPIC_API_KEY = model.apiKey;
      if (model.baseUrl) env.ANTHROPIC_BASE_URL = model.baseUrl;
    } else {
      env.OPENAI_API_KEY = model.apiKey;
      // CCB 需要此标志来启用 OpenAI 协议
      env.CLAUDE_CODE_USE_OPENAI = "1";
      if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }
  }

  if (effectiveModelName) {
    env.ANTHROPIC_MODEL = effectiveModelName;
  }

  // 额外环境变量
  if (launchSpec.env) {
    Object.assign(env, launchSpec.env);
  }

  if (Object.keys(env).length > 0) {
    config.env = env;
  }

  // model 字段
  if (effectiveModelName) {
    config.model = effectiveModelName;
  }

  // modelType：从 protocol 映射，告诉 CCB 使用哪种 API 协议
  config.modelType = model.protocol;

  // 开启轻量模式，减少 token 消耗
  config.poorMode = true;

  // Hindsight 插件：检测 launchSpec.env 中的 HINDSIGHT_* 变量
  // 这些变量由 launch-spec-builder 在检测到"记忆开启"时注入
  if (launchSpec.env?.HINDSIGHT_API_URL) {
    config.enabledPlugins = { "hindsight-memory@hindsight": true };
  }

  return config;
}
