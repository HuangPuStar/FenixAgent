import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

export interface InstalledSkillReference {
  name: string;
  path: string;
}

/**
 * Claude Code 的 settings.json 格式。
 * 写入 workspace 下 .claude/settings.json。
 */
export interface CcbRuntimeConfig {
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

  if (model.apiKey) {
    // claude 使用 ANTHROPIC_AUTH_TOKEN 或 OPENAI_API_KEY
    if (model.protocol === "anthropic") {
      env.ANTHROPIC_AUTH_TOKEN = model.apiKey;
      if (model.baseUrl) env.ANTHROPIC_BASE_URL = model.baseUrl;
    } else {
      env.OPENAI_API_KEY = model.apiKey;
      if (model.baseUrl) env.OPENAI_BASE_URL = model.baseUrl;
    }
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
