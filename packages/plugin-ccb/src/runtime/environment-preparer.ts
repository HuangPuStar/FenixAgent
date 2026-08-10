import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { type AgentFileSpec, renderAgentFileMarkdown } from "@fenix/plugin-sdk";
import type { CcbMcpConfig, CcbRuntimeConfig, InstalledSkillReference } from "./runtime-config";

export const CCB_DIR_NAME = ".claude";
export const CCB_CONFIG_FILENAME = "settings.local.json";
export const CCB_SKILLS_DIR_NAME = "skills";
export const CCB_CLAUDE_MD_FILENAME = "CLAUDE.md";
export const MCP_CONFIG_FILENAME = ".mcp.json";
/** ccb/claude-code 的 subagent 发现目录（设计 §4） */
export const CCB_AGENTS_DIR_NAME = ".claude/agents";
/** 平台 subagent 写入清单文件名（dotfile；引擎按 *.md 发现 agent，不会被误读） */
export const SUBAGENTS_MANIFEST_FILENAME = ".fenix-subagents.json";

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
  const periEnv: Record<string, string> = {};
  // 仅透传 HINDSIGHT_* 环境变量给 Peri，模型认证信息已通过 config.providers 注入
  if (launchSpec.env) {
    for (const key of Object.keys(launchSpec.env)) {
      if (key.startsWith("HINDSIGHT_")) {
        periEnv[key] = launchSpec.env[key];
      }
    }
  }

  const settings: Record<string, unknown> = {
    config: {
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
    },
  };

  if (Object.keys(periEnv).length > 0) {
    settings.env = periEnv;
  }

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

/**
 * 落盘 subagent 渲染文件到 `.claude/agents/{name}.md`（ccb/claude-code 的 agent 发现目录）。
 * name 已在上游（专家库校验）防路径穿越，此处仍防御性跳过非法文件名。
 *
 * 同时按上次写入清单清理不再引用的陈旧文件：workspace 跨启动持久化，若只写不删，
 * 移除专家绑定后引擎仍会发现已解绑的 subagent（M6）。清理范围仅限平台自己写过的
 * 文件（manifest 记录），避免误删用户自建 agent 文件；与 claude-code 插件共用同一
 * manifest（同一发现目录、同一 subagent 集合）。
 */
export async function writeSubagentAgentFiles(workspace: string, subagents: AgentFileSpec[]): Promise<string[]> {
  const agentsDir = join(workspace, CCB_AGENTS_DIR_NAME);
  await mkdir(agentsDir, { recursive: true });

  // 读取上次平台写入的文件名清单（无 manifest / 格式损坏 → 首次写入或旧目录，跳过清理）
  let previous: string[] = [];
  const manifestPath = join(agentsDir, SUBAGENTS_MANIFEST_FILENAME);
  try {
    const raw = await readFile(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as { written?: unknown };
    if (Array.isArray(parsed.written)) {
      previous = parsed.written.filter((n): n is string => typeof n === "string");
    }
  } catch {
    /* ignore */
  }

  const valid = subagents.filter(
    (s) => s.name && !s.name.includes("/") && !s.name.includes("\\") && !s.name.includes(".."),
  );
  const currentNames = new Set(valid.map((s) => s.name));

  // 清理上次平台写入、本次不再引用的陈旧文件
  for (const name of previous) {
    if (currentNames.has(name)) continue;
    try {
      await rm(join(agentsDir, `${name}.md`), { force: true });
    } catch (err) {
      // 清理失败不阻塞写入（最坏后果是引擎多发现一个陈旧 subagent，启动后无引用）
      console.warn(`[ccb] failed to remove stale subagent file '${name}.md'`, err);
    }
  }

  const written: string[] = [];
  for (const subagent of valid) {
    const filePath = join(agentsDir, `${subagent.name}.md`);
    await writeFile(filePath, renderAgentFileMarkdown(subagent), "utf8");
    written.push(filePath);
  }
  await writeFile(manifestPath, `${JSON.stringify({ written: valid.map((s) => s.name) })}\n`, "utf8");
  return written;
}
