import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { log, error as logError } from "@fenix/logger";
import type { AgentLaunchSpec, McpServerConfig, ModelConfig } from "@fenix/plugin-sdk";
import { getBaseUrl } from "../config";
import { listAgentKnowledgeBindingsById } from "./agent-knowledge";
import type { AgentFullConfig } from "./config/index";
import { getGlobalSkillsDir } from "./skill";
import { buildSkillDownloadUrl } from "./skill-download-token";
import { getSkillArchivePath, getSkillSourceDir } from "./skill-fs";

type LaunchModelProtocol = ModelConfig["protocol"];

function summarizeProviders(providers: AgentFullConfig["providers"]) {
  return providers.map((provider) => ({
    id: provider.id,
    organizationId: provider.organizationId,
    name: provider.name,
    displayName: provider.displayName ?? null,
    resourceKey: provider.resourceAccess?.resourceKey ?? null,
    ownership: provider.resourceAccess?.ownership ?? null,
    hasApiKey: Boolean(provider.apiKey),
    baseUrl: provider.baseUrl || "",
    protocol: provider.protocol ?? null,
  }));
}

function summarizeSkills(skills: AgentFullConfig["skills"]) {
  return skills.map((skill) => ({
    id: skill.id,
    organizationId: skill.organizationId,
    name: skill.name,
    contentPath: skill.contentPath ?? null,
    resourceKey: skill.resourceAccess?.resourceKey ?? null,
    ownership: skill.resourceAccess?.ownership ?? null,
  }));
}

function summarizeRawMcpServers(mcpServers: AgentFullConfig["mcpServers"]) {
  return mcpServers.map((server) => ({
    id: server.id,
    organizationId: server.organizationId,
    name: server.name,
    enabled: server.enabled,
    type: server.type,
    configType:
      server.config && typeof server.config === "object"
        ? ((server.config as Record<string, unknown>).type ?? null)
        : null,
  }));
}

function summarizeLaunchMcpServers(mcpServers: McpServerConfig[]) {
  return mcpServers.map((server) => ({
    name: server.name,
    type: server.type,
    command: server.type === "stdio" ? server.command : undefined,
    url: server.type === "streamable-http" ? server.url : undefined,
    timeout: server.timeout,
  }));
}

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

  if (!modelRef) {
    log("[launch-spec-builder] resolveModelConfig: modelRef is empty, using fallback model");
    return fallback;
  }

  log(
    `[launch-spec-builder] resolveModelConfig: start modelRef='${modelRef}', providers=${JSON.stringify(summarizeProviders(providers))}`,
  );

  const stableParts = modelRef.split("/");
  if (stableParts.length >= 3) {
    const resourceKey = `${stableParts[0]}/${stableParts[1]}`;
    const modelId = stableParts.slice(2).join("/");
    const prov = providers.find((p) => p.resourceAccess?.resourceKey === resourceKey);
    if (!prov) {
      log(
        `[launch-spec-builder] resolveModelConfig: no shared provider matched resourceKey='${resourceKey}', fallback model='${modelRef}'`,
      );
      return { ...fallback, model: modelRef };
    }

    log(
      `[launch-spec-builder] resolveModelConfig: matched shared provider resourceKey='${resourceKey}' -> provider='${prov.name}', modelId='${modelId}', hasApiKey=${Boolean(prov.apiKey)}`,
    );

    return {
      provider: prov.name,
      protocol: toLaunchModelProtocol(prov.protocol, prov.name),
      baseUrl: prov.baseUrl || "",
      apiKey: prov.apiKey || "",
      model: modelId,
    };
  }

  const slashIndex = modelRef.indexOf("/");
  if (slashIndex < 0) {
    return { ...fallback, model: modelRef };
  }

  const providerName = modelRef.slice(0, slashIndex);
  const modelId = modelRef.slice(slashIndex + 1);

  const candidates = providers.filter((p) => p.name === providerName);
  const prov =
    candidates.find((p) => p.resourceAccess?.ownership === "internal") ??
    candidates.find((p) => p.resourceAccess === undefined) ??
    candidates[0];
  if (!prov) {
    log(
      `[launch-spec-builder] resolveModelConfig: no legacy provider matched providerName='${providerName}', fallback model='${modelRef}'`,
    );
    return { ...fallback, model: modelRef };
  }
  if (candidates.length > 1) {
    log(
      `[launch-spec-builder] resolveModelConfig: provider '${providerName}' has ${candidates.length} candidates, prefer ${prov.organizationId}/${prov.id}`,
    );
  }

  log(
    `[launch-spec-builder] resolveModelConfig: matched legacy providerName='${providerName}' -> provider='${prov.name}', modelId='${modelId}', hasApiKey=${Boolean(prov.apiKey)}`,
  );

  return {
    provider: prov.name,
    protocol: toLaunchModelProtocol(prov.protocol, prov.name),
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

  log(
    `[launch-spec-builder] buildLaunchSpec: agent='${agentName}', agentConfigId='${agentConfigId ?? ""}', modelRef='${modelRef ?? ""}', providerCount=${fullConfig.providers.length}, skillCount=${fullConfig.skills.length}, mcpCount=${fullConfig.mcpServers.length}`,
  );
  log(
    `[launch-spec-builder] buildLaunchSpec: raw providers=${JSON.stringify(summarizeProviders(fullConfig.providers))}, raw skills=${JSON.stringify(summarizeSkills(fullConfig.skills))}, raw mcpServers=${JSON.stringify(summarizeRawMcpServers(fullConfig.mcpServers))}`,
  );
  const model = resolveModelConfig(modelRef, fullConfig.providers);
  log(
    `[launch-spec-builder] buildLaunchSpec: resolved model provider='${model.provider}', model='${model.model}', modelName='${model.modelName ?? ""}', baseUrl='${model.baseUrl}', hasApiKey=${Boolean(model.apiKey)}`,
  );

  const mcpServers: McpServerConfig[] = [];
  for (const server of fullConfig.mcpServers) {
    let raw: Record<string, unknown>;
    try {
      raw = typeof server.config === "string" ? JSON.parse(server.config) : (server.config as Record<string, unknown>);
    } catch {
      log(`[launch-spec-builder] 跳过无效 JSON 配置: ${server.name}`);
      continue;
    }
    log(
      `[launch-spec-builder] buildLaunchSpec: translating mcp '${server.name}' rawType='${String(raw.type ?? server.type ?? "unknown")}'`,
    );
    const sdkConfig = toSdkMcpConfig(server.name, raw);
    if (sdkConfig) {
      mcpServers.push(sdkConfig);
      log(
        `[launch-spec-builder] buildLaunchSpec: translated mcp '${server.name}' -> ${JSON.stringify(summarizeLaunchMcpServers([sdkConfig])[0])}`,
      );
    } else {
      log(`[launch-spec-builder] buildLaunchSpec: mcp '${server.name}' skipped after translation`);
    }
  }

  const skillRoot = getGlobalSkillsDir();
  const skills: { name: string; url: string }[] = [];
  for (const s of fullConfig.skills) {
    const { archivePath, sourceDir } = resolveSkillArchivePath(skillRoot, s);
    log(
      `[launch-spec-builder] buildLaunchSpec: translating skill '${s.name}' sourceDir='${sourceDir}' archivePath='${archivePath}' contentPath='${s.contentPath ?? ""}'`,
    );
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
    log(
      `[launch-spec-builder] buildLaunchSpec: translated skill '${s.name}' -> url generated for org='${s.organizationId}', id='${s.id}'`,
    );
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
    log(`[launch-spec-builder] buildLaunchSpec: appended knowledge mcp for ${knowledgeBindings.length} bindings`);
  }

  log(
    `[launch-spec-builder] buildLaunchSpec: final skills=${JSON.stringify(skills)}, final mcpServers=${JSON.stringify(summarizeLaunchMcpServers(mcpServers))}`,
  );

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
