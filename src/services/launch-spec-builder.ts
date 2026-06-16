import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { log, error as logError } from "@fenix/logger";
import type { AgentLaunchSpec, McpServerConfig, ModelConfig } from "@fenix/plugin-sdk";
import { and, asc, eq, inArray, or } from "drizzle-orm";
import { getBaseUrl } from "../config";
import { db } from "../db";
import { agentConfigSkill, mcpServer, model, provider, skill } from "../db/schema";
import { AppError } from "../errors";
import { listAgentKnowledgeBindingsById } from "./agent-knowledge";
import type { AgentConfigDetailWithAccess } from "./config";
import { getGlobalSkillsDir } from "./skill";
import { buildSkillDownloadUrl } from "./skill-download-token";
import { buildSkillArchive, getSkillArchivePath, getSkillSourceDir } from "./skill-fs";

type LaunchModelProtocol = ModelConfig["protocol"];
type ProviderRow = typeof provider.$inferSelect;
type ModelRow = typeof model.$inferSelect;
type SkillRow = typeof skill.$inferSelect;
type McpServerRow = typeof mcpServer.$inferSelect;

function summarizeProviders(providers: ProviderRow[]) {
  return providers.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    displayName: row.displayName ?? null,
    protocol: row.protocol ?? null,
    baseUrl: row.baseUrl || "",
    hasApiKey: Boolean(row.apiKey),
  }));
}

function summarizeSkills(skills: SkillRow[]) {
  return skills.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
  }));
}

function summarizeRawMcpServers(mcpServers: McpServerRow[]) {
  return mcpServers.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    name: row.name,
    enabled: row.enabled,
    type: row.type,
    configType:
      row.config && typeof row.config === "object" ? ((row.config as Record<string, unknown>).type ?? null) : null,
  }));
}

function summarizeLaunchMcpServers(mcpServers: McpServerConfig[]) {
  return mcpServers.map((row) => ({
    name: row.name,
    type: row.type,
    command: row.type === "stdio" ? row.command : undefined,
    url: row.type === "streamable-http" ? row.url : undefined,
    timeout: row.timeout,
  }));
}

function summarizeModels(models: ModelRow[]) {
  return models.map((row) => ({
    id: row.id,
    organizationId: row.organizationId,
    providerId: row.providerId,
    modelId: row.modelId,
    displayName: row.displayName ?? null,
  }));
}

/** 统一记录上下文日志并抛配置错误，保证前端拿到的是启动前失败而不是运行时伪成功。 */
function throwInvalidConfig(message: string, detail: string, error?: unknown): never {
  if (error) {
    logError(detail, error);
  } else {
    logError(detail);
  }
  throw new AppError(message, "INVALID_CONFIG", 400);
}

/** 共享资源格式固定为 `sourceOrg/providerId/modelId`，这里显式拆开供后续精准查库。 */
function parseSharedModelRef(modelRef: string) {
  const parts = modelRef.split("/");
  if (parts.length < 3) return null;
  return {
    organizationId: parts[0] ?? "",
    providerId: parts[1] ?? "",
    modelId: parts.slice(2).join("/"),
  };
}

/** 兼容旧格式 `providerName/modelId`，仅用于历史 AgentConfig 的迁移期读取。 */
function parseLegacyModelRef(modelRef: string) {
  const slashIndex = modelRef.indexOf("/");
  if (slashIndex < 0) return null;
  return {
    providerName: modelRef.slice(0, slashIndex),
    modelId: modelRef.slice(slashIndex + 1),
  };
}

/** 运行时目前只支持 plugin-sdk 明确声明的协议，未知协议直接阻断启动以暴露配置问题。 */
function toLaunchModelProtocol(
  protocol: string | null | undefined,
  providerName: string,
  agentConfigId: string,
): LaunchModelProtocol {
  if (protocol === "openai" || protocol === "anthropic") return protocol;
  throwInvalidConfig(
    `AgentConfig '${agentConfigId}' references provider '${providerName}' with unsupported protocol`,
    `[launch-spec-builder] unsupported provider protocol for agentConfig='${agentConfigId}', provider='${providerName}', protocol='${protocol ?? ""}'`,
  );
}

/**
 * 直接按 AgentConfig 当前声明的 modelRef 查 provider。
 *
 * 这里不再接受“上游聚合好的 providers”，是为了避免再出现
 * “先取一包候选数据、再在 builder 内二次筛选”的职责重叠。
 */
async function resolveModelConfig(agentConfig: AgentConfigDetailWithAccess): Promise<ModelConfig> {
  // Phase 1: 先收紧最基础的输入约束，避免后面查库时把“空 modelRef”误判成资源缺失。
  const modelRef = agentConfig.model?.trim();
  if (!modelRef) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' has no model configured`,
      `[launch-spec-builder] missing modelRef for agentConfig='${agentConfig.id}', org='${agentConfig.organizationId}'`,
    );
  }

  log(`[launch-spec-builder] resolveModelConfig: start agentConfig='${agentConfig.id}', modelRef='${modelRef}'`);

  // Phase 2: 优先处理稳定共享引用 `sourceOrg/providerId/modelId`，这是跨组织场景的主路径。
  const sharedModelRef = parseSharedModelRef(modelRef);
  if (sharedModelRef) {
    const rows = await db
      .select()
      .from(provider)
      .where(
        and(eq(provider.organizationId, sharedModelRef.organizationId), eq(provider.id, sharedModelRef.providerId)),
      )
      .limit(1);
    const matched = rows[0];
    if (!matched) {
      throwInvalidConfig(
        `AgentConfig '${agentConfig.id}' references missing model provider '${sharedModelRef.organizationId}/${sharedModelRef.providerId}'`,
        `[launch-spec-builder] missing shared provider for agentConfig='${agentConfig.id}', modelRef='${modelRef}', providerRef='${sharedModelRef.organizationId}/${sharedModelRef.providerId}'`,
      );
    }

    log(
      `[launch-spec-builder] resolveModelConfig: matched shared provider=${JSON.stringify(
        summarizeProviders([matched])[0],
      )}, modelId='${sharedModelRef.modelId}'`,
    );

    const modelRows = await db
      .select()
      .from(model)
      .where(
        and(
          eq(model.organizationId, matched.organizationId),
          eq(model.providerId, matched.id),
          eq(model.modelId, sharedModelRef.modelId),
        ),
      )
      .limit(1);
    const matchedModel = modelRows[0];
    if (!matchedModel) {
      throwInvalidConfig(
        `AgentConfig '${agentConfig.id}' references missing model '${sharedModelRef.modelId}'`,
        `[launch-spec-builder] missing shared model row for agentConfig='${agentConfig.id}', provider='${matched.organizationId}/${matched.id}', modelId='${sharedModelRef.modelId}', available=${JSON.stringify(
          summarizeModels(modelRows),
        )}`,
      );
    }

    return {
      provider: matched.name,
      protocol: toLaunchModelProtocol(matched.protocol, matched.name, agentConfig.id),
      baseUrl: matched.baseUrl || "",
      apiKey: matched.apiKey || "",
      model: matchedModel.modelId,
    };
  }

  // Phase 3: 兼容历史 `providerName/modelId` 格式，只在当前 AgentConfig 所属组织内解析 provider。
  const legacyModelRef = parseLegacyModelRef(modelRef);
  if (!legacyModelRef) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' has invalid model ref '${modelRef}'`,
      `[launch-spec-builder] invalid legacy modelRef for agentConfig='${agentConfig.id}', modelRef='${modelRef}'`,
    );
  }

  const rows = await db
    .select()
    .from(provider)
    .where(
      and(
        eq(provider.organizationId, agentConfig.organizationId),
        or(eq(provider.name, legacyModelRef.providerName), eq(provider.displayName, legacyModelRef.providerName)),
      ),
    )
    .limit(5);

  if (rows.length === 0) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing model provider '${legacyModelRef.providerName}'`,
      `[launch-spec-builder] missing legacy provider for agentConfig='${agentConfig.id}', modelRef='${modelRef}', providerName='${legacyModelRef.providerName}'`,
    );
  }

  const matched =
    rows.find((row) => row.name === legacyModelRef.providerName) ??
    rows.find((row) => row.displayName === legacyModelRef.providerName) ??
    rows[0];
  if (!matched) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing model provider '${legacyModelRef.providerName}'`,
      `[launch-spec-builder] empty provider candidates after lookup for agentConfig='${agentConfig.id}', modelRef='${modelRef}'`,
    );
  }

  if (rows.length > 1) {
    log(
      `[launch-spec-builder] resolveModelConfig: multiple legacy providers matched for agentConfig='${agentConfig.id}', providerName='${legacyModelRef.providerName}', chosen='${matched.organizationId}/${matched.id}'`,
    );
  }

  log(
    `[launch-spec-builder] resolveModelConfig: matched legacy provider=${JSON.stringify(
      summarizeProviders([matched])[0],
    )}, modelId='${legacyModelRef.modelId}'`,
  );

  const modelRows = await db
    .select()
    .from(model)
    .where(
      and(
        eq(model.organizationId, matched.organizationId),
        eq(model.providerId, matched.id),
        eq(model.modelId, legacyModelRef.modelId),
      ),
    )
    .limit(1);
  const matchedModel = modelRows[0];
  if (!matchedModel) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing model '${legacyModelRef.modelId}'`,
      `[launch-spec-builder] missing legacy model row for agentConfig='${agentConfig.id}', provider='${matched.organizationId}/${matched.id}', modelId='${legacyModelRef.modelId}', available=${JSON.stringify(
        summarizeModels(modelRows),
      )}`,
    );
  }

  return {
    provider: matched.name,
    protocol: toLaunchModelProtocol(matched.protocol, matched.name, agentConfig.id),
    baseUrl: matched.baseUrl || "",
    apiKey: matched.apiKey || "",
    model: matchedModel.modelId,
  };
}

/**
 * 为“无 AgentConfig 绑定”的最小启动路径解析一个可运行模型。
 *
 * 1. 不继承任何 prompt / skill / MCP
 * 2. 仅从当前用户可读的 provider/model 中挑第一个可用项
 * 3. 如果一个模型都没有，则直接报错，引导用户先完成基础模型配置
 */
async function resolveFirstReadableModelConfig(input: {
  organizationId: string;
  userId: string;
  environmentId?: string;
}): Promise<ModelConfig> {
  const sortedProviders = await db
    .select()
    .from(provider)
    .where(eq(provider.organizationId, input.organizationId))
    .orderBy(asc(provider.createdAt), asc(provider.id));

  for (const providerRow of sortedProviders) {
    const modelRows = await db
      .select()
      .from(model)
      .where(and(eq(model.organizationId, providerRow.organizationId), eq(model.providerId, providerRow.id)))
      .orderBy(asc(model.createdAt), asc(model.id))
      .limit(1);
    const firstModel = modelRows[0];
    if (!firstModel) {
      log(
        `[launch-spec-builder] resolveFirstReadableModelConfig: skip provider without model org='${providerRow.organizationId}', provider='${providerRow.id}'`,
      );
      continue;
    }

    log(
      `[launch-spec-builder] resolveFirstReadableModelConfig: selected provider='${providerRow.organizationId}/${providerRow.id}', model='${firstModel.modelId}'`,
    );
    return {
      provider: providerRow.name,
      protocol: toLaunchModelProtocol(providerRow.protocol, providerRow.name, input.environmentId ?? "minimal"),
      baseUrl: providerRow.baseUrl || "",
      apiKey: providerRow.apiKey || "",
      model: firstModel.modelId,
    };
  }

  throwInvalidConfig(
    "Default agent requires at least one configured model. Please configure a model first, then retry.",
    `[launch-spec-builder] resolveFirstReadableModelConfig: no readable model for org='${input.organizationId}', user='${input.userId}', environmentId='${input.environmentId ?? ""}'. minimal launch spec requires at least one readable model`,
  );
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

function resolveSkillArchivePath(skillRoot: string, row: SkillRow) {
  return {
    archivePath: getSkillArchivePath(skillRoot, row.organizationId, row.name),
    sourceDir: getSkillSourceDir(skillRoot, row.organizationId, row.name),
  };
}

/**
 * 读取 Agent 绑定的 skill 行，并保持与绑定顺序一致。
 *
 * 这里对“绑定存在但 skill 行缺失”直接失败，因为这种状态通常意味着
 * 配置被破坏，继续启动只会把错误延后到运行时。
 */
async function loadAgentSkills(agentConfig: AgentConfigDetailWithAccess): Promise<SkillRow[]> {
  const bindings = await db
    .select({ skillId: agentConfigSkill.skillId })
    .from(agentConfigSkill)
    .where(eq(agentConfigSkill.agentConfigId, agentConfig.id));
  if (bindings.length === 0) {
    return [];
  }

  const skillIds = bindings.map((row) => row.skillId);
  const skillRows = await db.select().from(skill).where(inArray(skill.id, skillIds));
  const skillById = new Map(skillRows.map((row) => [row.id, row]));
  const missingSkillIds = skillIds.filter((skillId) => !skillById.has(skillId));
  if (missingSkillIds.length > 0) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing skills`,
      `[launch-spec-builder] missing skill rows for agentConfig='${agentConfig.id}', missingSkillIds=${JSON.stringify(missingSkillIds)}, available=${JSON.stringify(
        summarizeSkills(skillRows),
      )}`,
    );
  }

  return skillIds.map((skillId) => skillById.get(skillId) as SkillRow);
}

/** MCP 仍按 AgentConfig 所属组织加载 enabled 项，builder 不再承担权限判定职责。 */
async function loadEnabledMcpServers(agentConfig: AgentConfigDetailWithAccess): Promise<McpServerRow[]> {
  return db
    .select()
    .from(mcpServer)
    .where(and(eq(mcpServer.organizationId, agentConfig.organizationId), eq(mcpServer.enabled, true)));
}

/**
 * 将数据库中的 MCP 配置翻译成 runtime 可消费的 SDK 配置。
 *
 * 这里不再对非法结构做 skip，因为 skip 会让实例“看起来能启动”，
 * 但工具集其实已经残缺，排查成本比直接失败更高。
 */
function toSdkMcpConfig(name: string, raw: Record<string, unknown>, agentConfigId: string): McpServerConfig {
  if (raw.type === "local") {
    if (!Array.isArray(raw.command) || raw.command.length === 0 || typeof raw.command[0] !== "string") {
      throwInvalidConfig(
        `AgentConfig '${agentConfigId}' has invalid MCP config '${name}'`,
        `[launch-spec-builder] invalid local MCP command for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
      );
    }
    const cmd = raw.command.filter((value): value is string => typeof value === "string");
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
    if (typeof raw.url !== "string" || raw.url.trim().length === 0) {
      throwInvalidConfig(
        `AgentConfig '${agentConfigId}' has invalid MCP config '${name}'`,
        `[launch-spec-builder] invalid remote MCP url for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
      );
    }
    return {
      name,
      type: "streamable-http",
      url: raw.url,
      headers: raw.headers as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  if (raw.type === "stdio") {
    if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
      throwInvalidConfig(
        `AgentConfig '${agentConfigId}' has invalid MCP config '${name}'`,
        `[launch-spec-builder] invalid stdio MCP command for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
      );
    }
    return {
      name,
      type: "stdio",
      command: raw.command,
      args: Array.isArray(raw.args)
        ? raw.args.filter((value): value is string => typeof value === "string")
        : undefined,
      env: raw.env as Record<string, string> | undefined,
      timeout: typeof raw.timeout === "number" ? raw.timeout : undefined,
    };
  }

  throwInvalidConfig(
    `AgentConfig '${agentConfigId}' has unsupported MCP config '${name}'`,
    `[launch-spec-builder] unsupported MCP config type for agentConfig='${agentConfigId}', mcp='${name}', raw=${JSON.stringify(raw)}`,
  );
}

/**
 * 确保每个 skill 都具备可下载的归档包。
 *
 * 归档缺失或过期时会尝试重建；若源目录本身就不存在，则直接视为配置损坏。
 */
async function buildSkillSpecs(agentConfig: AgentConfigDetailWithAccess, skills: SkillRow[]) {
  const skillRoot = getGlobalSkillsDir();
  const resolvedSkills: { name: string; url: string }[] = [];
  for (const row of skills) {
    const { archivePath, sourceDir } = resolveSkillArchivePath(skillRoot, row);
    log(
      `[launch-spec-builder] buildLaunchSpec: translating skill '${row.name}' sourceDir='${sourceDir}' archivePath='${archivePath}' skillOrg='${row.organizationId}'`,
    );

    if (!existsSync(sourceDir)) {
      throwInvalidConfig(
        `AgentConfig '${agentConfig.id}' references missing skill source '${row.name}'`,
        `[launch-spec-builder] missing skill source directory for agentConfig='${agentConfig.id}', skill='${row.name}', sourceDir='${sourceDir}'`,
      );
    }

    if (isSkillStale(sourceDir, archivePath)) {
      log(`[launch-spec-builder] Skill archive stale, rebuilding: ${row.name}`);
      try {
        await buildSkillArchive(sourceDir, archivePath);
      } catch (error) {
        throwInvalidConfig(
          `AgentConfig '${agentConfig.id}' failed to build skill archive '${row.name}'`,
          `[launch-spec-builder] failed to rebuild skill archive for agentConfig='${agentConfig.id}', skill='${row.name}', archivePath='${archivePath}'`,
          error,
        );
      }
    }

    if (!existsSync(archivePath)) {
      throwInvalidConfig(
        `AgentConfig '${agentConfig.id}' references missing skill archive '${row.name}'`,
        `[launch-spec-builder] missing skill archive after rebuild for agentConfig='${agentConfig.id}', skill='${row.name}', archivePath='${archivePath}'`,
      );
    }

    resolvedSkills.push({
      name: row.name,
      url: buildSkillDownloadUrl(
        { id: row.id, organizationId: row.organizationId, name: row.name },
        { expiresInSeconds: 3600 },
      ),
    });
  }
  return resolvedSkills;
}

/** 构造运行时 LaunchSpec 所需的最小输入，所有资源都从 agentConfig 向外解析。 */
export interface BuildLaunchSpecInput {
  organizationId: string;
  userId: string;
  environmentId?: string;
  agentConfig: AgentConfigDetailWithAccess;
  environmentSecret: string;
  extraEnv?: Record<string, string>;
}

/** 未绑定 AgentConfig 时的最小启动参数。 */
export interface BuildBasicLaunchSpecInput {
  organizationId: string;
  userId: string;
  environmentId?: string;
  extraEnv?: Record<string, string>;
}

/** 可替换的 buildLaunchSpec 实现（测试时注入 mock） */
let _buildLaunchSpec: ((input: BuildLaunchSpecInput) => Promise<AgentLaunchSpec>) | null = null;

/** 测试用：注入自定义 buildLaunchSpec。传 null 恢复默认实现。 */
export function setBuildLaunchSpec(fn: ((input: BuildLaunchSpecInput) => Promise<AgentLaunchSpec>) | null) {
  _buildLaunchSpec = fn;
}

/**
 * 按 agentConfig 直接解析启动所需资源，并构造最终的 AgentLaunchSpec。
 *
 * 设计约束：
 * 1. 不做权限判断，默认上游已完成 agentConfig 可见性校验
 * 2. 不做 fallback，任何关键资源缺失都直接失败
 * 3. builder 自己取数，避免半成品聚合层与组装层重复筛选
 */
export async function buildLaunchSpec(input: BuildLaunchSpecInput): Promise<AgentLaunchSpec> {
  if (_buildLaunchSpec) return _buildLaunchSpec(input);

  const { organizationId, userId, environmentId, agentConfig, environmentSecret } = input;
  log(
    `[launch-spec-builder] buildLaunchSpec: agent='${agentConfig.name}', agentConfigId='${agentConfig.id}', modelRef='${agentConfig.model ?? ""}', org='${agentConfig.organizationId}'`,
  );

  // Phase 1: 先并行拿到构造 launchSpec 的原始资源，确保错误尽早暴露。
  const [model, skillRows, rawMcpServers, knowledgeBindings] = await Promise.all([
    resolveModelConfig(agentConfig),
    loadAgentSkills(agentConfig),
    loadEnabledMcpServers(agentConfig),
    listAgentKnowledgeBindingsById(agentConfig.id),
  ]);

  log(
    `[launch-spec-builder] buildLaunchSpec: loaded skills=${JSON.stringify(summarizeSkills(skillRows))}, raw mcpServers=${JSON.stringify(summarizeRawMcpServers(rawMcpServers))}`,
  );
  log(
    `[launch-spec-builder] buildLaunchSpec: resolved model provider='${model.provider}', model='${model.model}', modelName='${model.modelName ?? ""}', baseUrl='${model.baseUrl}', hasApiKey=${Boolean(model.apiKey)}`,
  );

  // Phase 2: 将数据库配置翻译成 runtime 层真正消费的结构。
  const mcpServers: McpServerConfig[] = [];
  for (const row of rawMcpServers) {
    let raw: Record<string, unknown>;
    try {
      raw = typeof row.config === "string" ? JSON.parse(row.config) : (row.config as Record<string, unknown>);
    } catch (error) {
      throwInvalidConfig(
        `AgentConfig '${agentConfig.id}' has invalid MCP config '${row.name}'`,
        `[launch-spec-builder] invalid MCP JSON for agentConfig='${agentConfig.id}', mcp='${row.name}', rawConfig='${String(row.config)}'`,
        error,
      );
    }
    log(
      `[launch-spec-builder] buildLaunchSpec: translating mcp '${row.name}' rawType='${String(raw.type ?? row.type ?? "unknown")}'`,
    );
    mcpServers.push(toSdkMcpConfig(row.name, raw, agentConfig.id));
  }

  const skills = await buildSkillSpecs(agentConfig, skillRows);

  // Knowledge 绑定不是普通 mcpServer 行，而是平台注入的保留 MCP 入口。
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

  // Phase 3: 产出最终 launchSpec，此时所有关键资源都已经完成严格校验。
  return {
    organizationId,
    userId,
    ...(environmentId ? { environmentId } : {}),
    env: input.extraEnv ?? {},
    agent: {
      name: agentConfig.name,
      ...(agentConfig.prompt ? { prompt: agentConfig.prompt } : {}),
    },
    model,
    skills,
    mcpServers,
  };
}

/**
 * 构造一个不依赖 AgentConfig 的最小 LaunchSpec。
 *
 * 上层会决定哪些环境允许走这条路径；builder 这里只负责产出一个
 * “第一个可用模型 + 空资源集”的最小运行配置。
 */
export async function buildBasicLaunchSpec(input: BuildBasicLaunchSpecInput): Promise<AgentLaunchSpec> {
  const modelConfig = await resolveFirstReadableModelConfig(input);
  log(
    `[launch-spec-builder] buildBasicLaunchSpec: org='${input.organizationId}', user='${input.userId}', environmentId='${input.environmentId ?? ""}', provider='${modelConfig.provider}', model='${modelConfig.model}'`,
  );

  return {
    organizationId: input.organizationId,
    userId: input.userId,
    ...(input.environmentId ? { environmentId: input.environmentId } : {}),
    env: input.extraEnv ?? {},
    agent: {
      name: "build",
    },
    model: modelConfig,
    skills: [],
    mcpServers: [],
  };
}
