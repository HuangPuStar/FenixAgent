import { existsSync, readdirSync, statSync } from "node:fs";
import { log, error as logError } from "@fenix/logger";
import { dirname, join } from "node:path";
import type { AgentLaunchSpec, McpServerConfig, ModelConfig } from "@fenix/plugin-sdk";
import { getBaseUrl } from "../config";
import { listAgentKnowledgeBindingsById } from "./agent-knowledge";
import type { AgentFullConfig } from "./config/index";
import { getGlobalSkillsDir } from "./skill";
import { buildSkillDownloadUrl } from "./skill-download-token";
import { getSkillArchivePath, getSkillSourceDir } from "./skill-fs";

type LaunchModelProtocol = ModelConfig["protocol"];

/** 递归收集目录下所有文件的最晚修改时间 */
function getLatestMtime(dir: string): number {
  let latest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      latest = Math.max(latest, getLatestMtime(fullPath));
    } else if (entry.isFile()) {
      latest = Math.max(latest, statSync(fullPath).mtimeMs);
    }
  }
  return latest;
}

/** 判断 skill 源文件是否有更新，需要重建 archive */
function isSkillStale(sourceDir: string, archivePath: string): boolean {
  if (!existsSync(archivePath) || !existsSync(sourceDir)) return !existsSync(archivePath);
  const archiveMtime = statSync(archivePath).mtimeMs;
  return getLatestMtime(sourceDir) > archiveMtime;
}

function toLaunchModelProtocol(protocol: string | null | undefined, providerName: string): LaunchModelProtocol {
  if (protocol === "openai" || protocol === "anthropic") return protocol;
  log(
    `[launch-spec-builder] Provider '${providerName}' protocol '${protocol ?? "unknown"}' is not supported; using openai`,
  );
  return "openai";
}

/**
 * 将 DB 中的 MCP server JSONB 配置转换为 SDK McpServerConfig 格式。
 *
 * DB 格式 (opencode 格式):
 *   { type: "local", command: ["npx", "-y", "..."], environment: {...} }
 *   { type: "remote", url: "...", headers: {...} }
 *
 * SDK 格式:
 *   { type: "stdio", command: "npx", args: ["-y", "..."], env: {...} }
 *   { type: "streamable-http", url: "...", headers: {...} }
 */
function toSdkMcpConfig(name: string, raw: Record<string, unknown>): McpServerConfig | null {
  if (raw.type === "local" && Array.isArray(raw.command)) {
    const cmd = raw.command as string[];
    return {
      name,
      type: "stdio",
      command: cmd[0] ?? "",
      args: cmd.length > 1 ? cmd.slice(1) : undefined,
      env: raw.environment as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  if (raw.type === "remote" || raw.type === "streamable-http") {
    return {
      name,
      type: "streamable-http",
      url: raw.url as string,
      headers: raw.headers as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  if (raw.type === "stdio") {
    return {
      name,
      type: "stdio",
      command: raw.command as string,
      args: raw.args as string[] | undefined,
      env: raw.env as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  log(`[launch-spec-builder] 跳过无法识别的 MCP 配置: ${name} (type=${raw.type})`);
  return null;
}

function resolveModelConfig(modelRef: string | null | undefined, providers: AgentFullConfig["providers"]): ModelConfig {
  const fallback: ModelConfig = {
    provider: "openai",
    protocol: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "",
    model: "gpt-4o",
  };

  if (!modelRef) return fallback;

  const slashIndex = modelRef.indexOf("/");
  if (slashIndex < 0) {
    return { ...fallback, model: modelRef };
  }

  const providerName = modelRef.slice(0, slashIndex);
  const modelId = modelRef.slice(slashIndex + 1);

  const prov = providers.find((p) => p.name === providerName);
  if (!prov) {
    log(`[launch-spec-builder] 未找到 provider '${providerName}'，使用默认配置`);
    return { ...fallback, model: modelRef };
  }

  return {
    provider: providerName,
    protocol: toLaunchModelProtocol(prov.protocol, providerName),
    baseUrl: prov.baseUrl || "",
    apiKey: prov.apiKey || "",
    model: modelId,
  };
}

function resolveSkillArchivePath(skillRoot: string, row: AgentFullConfig["skills"][number]) {
  if (row.contentPath) {
    const sourceDir = dirname(row.contentPath);
    return { archivePath: `${sourceDir}.zip`, sourceDir };
  }
  return {
    archivePath: getSkillArchivePath(skillRoot, row.name),
    sourceDir: getSkillSourceDir(skillRoot, row.name),
  };
}

export interface BuildLaunchSpecInput {
  organizationId: string;
  userId: string;
  environmentId?: string;
  agentName: string;
  agentConfigId?: string | null;
  agentPrompt?: string | null;
  modelRef?: string | null;
  fullConfig: AgentFullConfig;
  environmentSecret: string;
  extraEnv?: Record<string, string>;
}

/** 可替换的 buildLaunchSpec 实现（测试时注入 mock） */
let _buildLaunchSpec: ((input: BuildLaunchSpecInput) => Promise<AgentLaunchSpec>) | null = null;

/** 测试用：注入自定义 buildLaunchSpec。传 null 恢复默认。 */
export function setBuildLaunchSpec(fn: ((input: BuildLaunchSpecInput) => Promise<AgentLaunchSpec>) | null) {
  _buildLaunchSpec = fn;
}

export async function buildLaunchSpec(input: BuildLaunchSpecInput): Promise<AgentLaunchSpec> {
  if (_buildLaunchSpec) return _buildLaunchSpec(input);
  const {
    organizationId,
    userId,
    environmentId,
    agentName,
    agentConfigId,
    agentPrompt,
    modelRef,
    fullConfig,
    environmentSecret,
  } = input;

  const agent = {
    name: agentName,
    ...(agentPrompt ? { prompt: agentPrompt } : {}),
  };

  const model = resolveModelConfig(modelRef, fullConfig.providers);

  const mcpServers: McpServerConfig[] = [];
  for (const server of fullConfig.mcpServers) {
    let raw: Record<string, unknown>;
    try {
      raw = typeof server.config === "string" ? JSON.parse(server.config) : (server.config as Record<string, unknown>);
    } catch {
      log(`[launch-spec-builder] 跳过无效 JSON 配置: ${server.name}`);
      continue;
    }
    const sdkConfig = toSdkMcpConfig(server.name, raw);
    if (sdkConfig) {
      mcpServers.push(sdkConfig);
    }
  }

  const skillRoot = getGlobalSkillsDir();
  const skills: { name: string; url: string }[] = [];
  for (const s of fullConfig.skills) {
    const { archivePath, sourceDir } = resolveSkillArchivePath(skillRoot, s);
    if (isSkillStale(sourceDir, archivePath)) {
      if (existsSync(sourceDir)) {
        log(`[launch-spec-builder] Skill archive stale, rebuilding: ${s.name}`);
        try {
          const { buildSkillArchive } = await import("./skill-fs");
          await buildSkillArchive(sourceDir, archivePath);
        } catch (err) {
          logError(`[launch-spec-builder] Failed to rebuild skill archive for ${s.name}:`, err);
          continue;
        }
      } else {
        logError(`[launch-spec-builder] Skill source directory missing: ${s.name} (path: ${sourceDir})`);
        continue;
      }
    }
    skills.push({
      name: s.name,
      url: buildSkillDownloadUrl(
        { id: s.id, organizationId: s.organizationId, name: s.name },
        { expiresInSeconds: 3600 },
      ),
    });
  }

  const knowledgeBindings = agentConfigId ? await listAgentKnowledgeBindingsById(agentConfigId) : [];
  if (knowledgeBindings.length > 0) {
    mcpServers.push({
      name: "kb",
      type: "streamable-http",
      url: `${getBaseUrl()}/mcp/knowledge`,
      headers: { Authorization: `Bearer ${environmentSecret}` },
      timeout: 15000,
    });
  }

  return {
    organizationId,
    userId,
    ...(environmentId ? { environmentId } : {}),
    ...(input.extraEnv ? { env: input.extraEnv } : {}),
    agent,
    model,
    skills,
    mcpServers,
  };
}
