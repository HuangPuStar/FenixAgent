import type { AgentLaunchSpec, McpServerConfig } from "@fenix/plugin-sdk";

export interface InstalledSkillReference {
  name: string;
  path: string;
}

/**
 * Claude Code 兼容的 settings.local.json 格式。
 * 写入 workspace 下 `.claude/settings.local.json`。
 *
 * Peri 兼容 Claude Code 生态（`.claude/skills`、`.claude/agents` 都按该布局读取），本文件承载的是
 * 模型环境变量、插件开关与权限这些 Claude 侧契约；Peri 自己的 provider/profile 配置另写
 * `.peri/settings.json`（见 `PeriSettingsFile`）。
 */
export interface PeriRuntimeConfig {
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
export interface PeriMcpConfig {
  mcpServers: Record<string, PeriMcpServerConfig>;
}

export interface PeriMcpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface PeriMcpRemoteConfig {
  url: string;
  headers?: Record<string, string>;
}

export type PeriMcpServerConfig = PeriMcpStdioConfig | PeriMcpRemoteConfig;

/** Peri profile 别名到模型的映射；四个别名共享同一模型，由 profile 决定推理强度。 */
export interface PeriProviderModels {
  opus: string;
  sonnet: string;
  haiku: string;
  fable: string;
}

export interface PeriProviderConfig {
  id: string;
  type: string;
  apiKey?: string;
  baseUrl?: string;
  name: string;
  models: PeriProviderModels;
}

export interface PeriProfileConfig {
  provider: string;
  model?: string;
  effort: "low" | "medium" | "max";
}

/**
 * `.peri/settings.json` 的格式（Peri CLI 的 project 级配置）。
 *
 * 与 `.claude/settings.local.json` 的分工：前者是 Peri 自己的 provider/profile 选型，后者是 Claude 兼容面。
 * 两份都要写——Peri 的模型鉴权走本文件的 providers，插件/权限仍走 `.claude`。
 */
export interface PeriSettingsFile {
  config: {
    active_alias: string;
    providers: PeriProviderConfig[];
    profiles: Record<string, PeriProfileConfig>;
    skills_dir: string | null;
    env?: Record<string, string>;
  };
}

function isStreamableHttp(server: McpServerConfig): server is Extract<McpServerConfig, { type: "streamable-http" }> {
  return server.type === "streamable-http";
}

/**
 * 把 AgentLaunchSpec.mcpServers 转为 .mcp.json 格式。
 */
export function buildPeriMcpConfig(launchSpec: AgentLaunchSpec): PeriMcpConfig | null {
  if (launchSpec.mcpServers.length === 0) return null;

  const mcpServers: Record<string, PeriMcpServerConfig> = {};
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
 * 把 AgentLaunchSpec 转为 Claude 兼容 settings.local.json 配置。
 */
export function buildPeriRuntimeConfig(
  launchSpec: AgentLaunchSpec,
  _installedSkills: InstalledSkillReference[],
): PeriRuntimeConfig {
  const config: PeriRuntimeConfig = {};

  const env: Record<string, string> = {};
  const { model } = launchSpec;
  // 对齐 opencode：优先用 modelName，fallback 到 model
  const effectiveModelName = model.modelName ?? model.model;

  if (model.apiKey) {
    if (model.protocol === "anthropic") {
      env.ANTHROPIC_AUTH_TOKEN = model.apiKey;
      // Peri 同时读取 ANTHROPIC_API_KEY，多写一份确保兼容
      env.ANTHROPIC_API_KEY = model.apiKey;
      if (model.baseUrl) env.ANTHROPIC_BASE_URL = model.baseUrl;
    } else {
      env.OPENAI_API_KEY = model.apiKey;
      // Peri 需要此标志来启用 OpenAI 协议
      env.CLAUDE_CODE_USE_OPENAI = "1";
      if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }
  }

  if (effectiveModelName) {
    env.ANTHROPIC_MODEL = effectiveModelName;
  }

  if (launchSpec.env) {
    Object.assign(env, launchSpec.env);
  }

  if (Object.keys(env).length > 0) {
    config.env = env;
  }

  if (effectiveModelName) {
    config.model = effectiveModelName;
  }

  // modelType：从 protocol 映射，告诉 Peri 使用哪种 API 协议
  config.modelType = model.protocol;

  // 开启轻量模式，减少 token 消耗
  config.poorMode = true;

  // Hindsight 插件：检测 launchSpec.env 中的 HINDSIGHT_* 变量
  // 这些变量由启动参数组装器在检测到"记忆开启"时注入
  // （`@fenix/agent-config` 的 `server/services/agent-launch-spec/memory-env.ts`）
  if (launchSpec.env?.HINDSIGHT_API_URL) {
    config.enabledPlugins = { "hindsight-memory@hindsight": true };
  }

  return config;
}

/**
 * 把 AgentLaunchSpec 的模型信息映射为 Peri 的 provider/profile 配置。
 *
 * 四个 profile 别名（opus/sonnet/haiku/fable）统一指向当前模型，由 profile 决定推理强度——
 * 与 Peri 侧的别名语义一致，模型切换只改本文件的 models 映射。
 */
export function buildPeriSettingsConfig(launchSpec: AgentLaunchSpec): PeriSettingsFile {
  const { model } = launchSpec;
  const modelId = model.modelName ?? model.model;
  const periEnv = launchSpec.env ? { ...launchSpec.env } : undefined;

  return {
    config: {
      active_alias: "opus",
      providers: [
        {
          id: model.provider,
          type: model.protocol,
          apiKey: model.apiKey,
          baseUrl: model.baseUrl,
          name: model.provider,
          models: {
            opus: modelId,
            sonnet: modelId,
            haiku: modelId,
            fable: modelId,
          },
        },
      ],
      profiles: {
        opus: {
          provider: model.provider,
          model: modelId,
          effort: "medium",
        },
        sonnet: {
          provider: model.provider,
          effort: "max",
        },
        haiku: {
          provider: model.provider,
          effort: "low",
        },
      },
      skills_dir: null,
      ...(periEnv && Object.keys(periEnv).length > 0 ? { env: periEnv } : {}),
    },
  };
}
