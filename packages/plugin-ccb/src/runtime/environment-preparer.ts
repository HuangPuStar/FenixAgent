import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import type { CcbMcpConfig, CcbRuntimeConfig, InstalledSkillReference } from "./runtime-config";

export const CCB_DIR_NAME = ".claude";
export const CCB_CONFIG_FILENAME = "settings.local.json";
export const CCB_SKILLS_DIR_NAME = "skills";
export const CCB_CLAUDE_MD_FILENAME = "CLAUDE.md";
export const MCP_CONFIG_FILENAME = ".mcp.json";

export interface PreparedWorkspacePaths {
  runtimeDir: string;
  skillsDir: string;
  configPath: string;
}

/**
 * 准备 .claude 目录 + skills 子目录。
 */
export async function ensureWorkspaceRuntimeDirs(workspace: string): Promise<PreparedWorkspacePaths> {
  const runtimeDir = join(workspace, CCB_DIR_NAME);
  const skillsDir = join(runtimeDir, CCB_SKILLS_DIR_NAME);
  const configPath = join(runtimeDir, CCB_CONFIG_FILENAME);

  await mkdir(runtimeDir, { recursive: true });
  await mkdir(skillsDir, { recursive: true });

  return { runtimeDir, skillsDir, configPath };
}

/**
 * 写入 settings.json。
 */
export async function writeCcbConfig(workspace: string, config: CcbRuntimeConfig): Promise<string> {
  const { configPath } = await ensureWorkspaceRuntimeDirs(workspace);
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 写入 .mcp.json（项目级 MCP server 配置）。
 */
export async function writeCcbMcpConfig(workspace: string, mcpConfig: CcbMcpConfig): Promise<string> {
  const configPath = join(workspace, MCP_CONFIG_FILENAME);
  await writeFile(configPath, `${JSON.stringify(mcpConfig, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 写入 CLAUDE.md（系统 prompt），放在 workspace 根目录（与 .mcp.json 同级）。
 */
export async function writeClaudeMd(workspace: string, content: string): Promise<string> {
  const claudeMdPath = join(workspace, CCB_CLAUDE_MD_FILENAME);
  await writeFile(claudeMdPath, content, "utf8");
  return claudeMdPath;
}

/**
 * IS_PERI 环境下，额外创建 .peri/settings.json 供 Peri 客户端使用。
 * 将 AgentLaunchSpec 的 model 信息转换为 Peri provider 格式。
 */
export async function writePeriSettings(workspace: string, launchSpec: AgentLaunchSpec): Promise<string | null> {
  if (!process.env.IS_PERI) return null;

  const { model } = launchSpec;
  const periDir = join(workspace, ".peri");
  await mkdir(periDir, { recursive: true });

  const modelId = model.modelName ?? model.model;
  // 透传所有 launchSpec.env 给 Peri（含 HINDSIGHT_*、USER_META_* 等平台级变量）
  // 模型认证信息已通过 config.providers 注入，不在此重复
  const periEnv: Record<string, string> = {};
  if (launchSpec.env) {
    for (const key of Object.keys(launchSpec.env)) {
      periEnv[key] = launchSpec.env[key];
    }
  }

  const configContent: Record<string, unknown> = {
    active_provider_id: model.provider,
    active_alias: "sonnet",
    providers: [
      {
        id: model.provider,
        type: model.protocol,
        apiKey: model.apiKey,
        baseUrl: model.baseUrl,
        models: {
          opus: modelId,
          sonnet: modelId,
          haiku: modelId,
        },
      },
    ],
    thinking: {
      enabled: true,
      budget_tokens: 8000,
      effort: "high",
    },
  };

  if (Object.keys(periEnv).length > 0) {
    configContent.env = periEnv;
  }

  const settings: Record<string, unknown> = {
    config: configContent,
  };

  const configPath = join(periDir, "settings.json");
  await writeFile(configPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  return configPath;
}

/**
 * 统一执行 workspace 环境物化。
 */
export async function prepareWorkspaceEnvironment(
  workspace: string,
  config: CcbRuntimeConfig,
  mcpConfig: CcbMcpConfig | null,
  agentPrompt?: string,
  _installedSkills: InstalledSkillReference[] = [],
): Promise<PreparedWorkspacePaths> {
  const paths = await ensureWorkspaceRuntimeDirs(workspace);

  // settings.json
  if (Object.keys(config).length > 0) {
    await writeCcbConfig(workspace, config);
  }

  // .mcp.json
  if (mcpConfig) {
    await writeCcbMcpConfig(workspace, mcpConfig);
  }

  // CLAUDE.md（workspace 根目录，与 .mcp.json 同级）
  if (agentPrompt) {
    await writeClaudeMd(workspace, agentPrompt);
  }

  return paths;
}
