import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { log, error as logError } from "@fenix/logger";
import type { AgentLaunchSpec, McpServerConfig, ModelConfig } from "@fenix/plugin-sdk";
import { and, asc, eq, inArray } from "drizzle-orm";
import { config, getBaseUrl } from "../config";
import { db } from "../db";
import {
  agentConfigMcp,
  agentConfigSkill,
  agentLitellmKey,
  mcpServer,
  member,
  model,
  provider,
  skill,
} from "../db/schema";
import { AppError } from "../errors";
import { listAgentKnowledgeBindingsById } from "./agent-knowledge";
import { HINDSIGHT_PLUGIN_DEFAULTS, shouldEnableAgentMemory } from "./agent-memory";
import { composeAgentSystemPrompt } from "./agent-system-prompt";
import type { AgentConfigDetailWithAccess } from "./config";
import { resolveApiKey } from "./config-utils";
import { addLitellmMember, generateLitellmKey } from "./litellm";
import { getGlobalSkillsDir } from "./skill";
import { buildSkillDownloadUrl } from "./skill-download-token";
import { buildSkillArchive, getSkillArchivePath, getSkillSourceDir } from "./skill-fs";

type LaunchModelProtocol = ModelConfig["protocol"];
type SkillRow = typeof skill.$inferSelect;
type McpServerRow = typeof mcpServer.$inferSelect;

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

/** 统一记录上下文日志并抛配置错误，保证前端拿到的是启动前失败而不是运行时伪成功。 */
function throwInvalidConfig(message: string, detail: string, error?: unknown): never {
  if (error) {
    logError(detail, error);
  } else {
    logError(detail);
  }
  throw new AppError(message, "INVALID_CONFIG", 400);
}

/** 运行时目前只支持 plugin-sdk 明确声明的协议，未知协议直接阻断启动以暴露配置问题。 */
function toLaunchModelProtocol(
  protocol: string | null | undefined,
  providerName: string,
  agentConfigId: string,
): LaunchModelProtocol {
  // LiteLLM 的 API 是 OpenAI 兼容格式，映射为 "openai"
  if (protocol === "litellm") return "openai";
  if (protocol === "openai" || protocol === "anthropic") return protocol;
  throwInvalidConfig(
    `AgentConfig '${agentConfigId}' references provider '${providerName}' with unsupported protocol`,
    `[launch-spec-builder] unsupported provider protocol for agentConfig='${agentConfigId}', provider='${providerName}', protocol='${protocol ?? ""}'`,
  );
}

/** 默认 Key 预算上限（USD） */
function getDefaultMaxBudget(): number {
  return parseFloat(process.env.RCS_LITELLM_DEFAULT_MAX_BUDGET || "50");
}

/**
 * 确保 LiteLLM Organization 中存在该用户的成员记录。
 * 通过 agent_litellm_key 表反查已有记录避免重复创建。
 */
async function ensureLitellmMember(userId: string, organizationId: string, litellmOrgId: string): Promise<string> {
  const existingMember = await db
    .select({ litellmUserId: agentLitellmKey.litellmUserId })
    .from(agentLitellmKey)
    .where(
      and(
        eq(agentLitellmKey.organizationId, organizationId),
        eq(agentLitellmKey.userId, userId),
        eq(agentLitellmKey.enabled, true),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existingMember) return existingMember.litellmUserId;

  const result = await addLitellmMember(litellmOrgId, userId, "user");
  return result.member_id;
}

/**
 * 确保 (用户, 智能体) 组合存在对应的 LiteLLM API Key。
 * 若已存在则直接返回明文 Key，否则懒创建。
 * 使用 INSERT + 唯一索引处理并发竞态。
 */
async function ensureLitellmKey(
  userId: string,
  agentConfig: { id: string; name: string; organizationId: string },
  matchedModel: { modelId: string },
  matchedProvider: {
    id: string;
    name: string;
    baseUrl: string | null;
    extraOptions: Record<string, unknown> | null;
  },
): Promise<string> {
  // 查询已有 Key
  const existing = await db
    .select({
      litellmKey: agentLitellmKey.litellmKey,
    })
    .from(agentLitellmKey)
    .where(
      and(
        eq(agentLitellmKey.userId, userId),
        eq(agentLitellmKey.agentConfigId, agentConfig.id),
        eq(agentLitellmKey.enabled, true),
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (existing) return existing.litellmKey;

  const litellmOrgId = (matchedProvider.extraOptions as any)?.litellmOrgId as string;
  if (!litellmOrgId) {
    throw new Error(`Provider '${matchedProvider.name}' 缺少 litellmOrgId，请确认 LiteLLM Organization 已创建`);
  }

  const memberId = await ensureLitellmMember(userId, agentConfig.organizationId, litellmOrgId);

  const keyAlias = `RCS:${agentConfig.name}`;
  const keyResult = await generateLitellmKey({
    user_id: memberId,
    agent_id: agentConfig.id,
    organization_id: litellmOrgId,
    key_alias: keyAlias,
    metadata: {
      rcs_user_id: userId,
      rcs_agent_config_id: agentConfig.id,
      rcs_org_id: agentConfig.organizationId,
    },
    tags: [`org:${agentConfig.organizationId}`, `agent:${agentConfig.id}`, `user:${userId}`],
    max_budget: getDefaultMaxBudget(),
    budget_duration: "30d",
    models: [matchedModel.modelId],
  });

  // INSERT with ON CONFLICT DO NOTHING for concurrency safety
  await db
    .insert(agentLitellmKey)
    .values({
      userId,
      agentConfigId: agentConfig.id,
      organizationId: agentConfig.organizationId,
      litellmOrgId,
      litellmUserId: memberId,
      litellmKeyId: keyResult.key_id ?? keyResult.token ?? keyResult.key,
      litellmKey: keyResult.key,
      litellmAgentId: agentConfig.id,
      keyAlias,
      tags: [`org:${agentConfig.organizationId}`, `agent:${agentConfig.id}`, `user:${userId}`],
    })
    .onConflictDoNothing();

  // Re-SELECT to handle concurrent race (winner takes all)
  const final = await db
    .select({ litellmKey: agentLitellmKey.litellmKey })
    .from(agentLitellmKey)
    .where(and(eq(agentLitellmKey.userId, userId), eq(agentLitellmKey.agentConfigId, agentConfig.id)))
    .limit(1);

  if (!final[0]) {
    throw new Error(`LiteLLM Key 创建失败: (user=${userId}, agent=${agentConfig.id})`);
  }

  return final[0].litellmKey;
}

/** 运行时只认正式的 modelId 外键；未指定时回退到当前组织第一个可用模型。 */
async function resolveModelConfig(agentConfig: AgentConfigDetailWithAccess): Promise<ModelConfig> {
  if (!agentConfig.modelId) {
    log(
      `[launch-spec-builder] agentConfig '${agentConfig.id}' has no modelId, falling back to first available model in org '${agentConfig.organizationId}'`,
    );
    return resolveFirstReadableModelConfig({
      organizationId: agentConfig.organizationId,
      userId: agentConfig.userId ?? agentConfig.organizationId,
    });
  }

  const modelRows = await db.select().from(model).where(eq(model.id, agentConfig.modelId)).limit(1);
  const matchedModel = modelRows[0];
  if (!matchedModel) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing model id '${agentConfig.modelId}'`,
      `[launch-spec-builder] missing model row by modelId for agentConfig='${agentConfig.id}', modelId='${agentConfig.modelId}'`,
    );
  }

  const providerRows = await db
    .select()
    .from(provider)
    .where(and(eq(provider.id, matchedModel.providerId), eq(provider.organizationId, matchedModel.organizationId)))
    .limit(1);
  const matchedProvider = providerRows[0];
  if (!matchedProvider) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing provider for model '${agentConfig.modelId}'`,
      `[launch-spec-builder] missing provider row for agentConfig='${agentConfig.id}', modelId='${agentConfig.modelId}', providerId='${matchedModel.providerId}'`,
    );
  }

  log(
    `[launch-spec-builder] resolveModelConfig: resolved modelId='${agentConfig.modelId}' to provider='${matchedProvider.organizationId}/${matchedProvider.id}', model='${matchedModel.modelId}'`,
  );
  return {
    provider: matchedProvider.name,
    protocol: toLaunchModelProtocol(matchedProvider.protocol, matchedProvider.name, agentConfig.id),
    baseUrl: matchedProvider.baseUrl || "",
    apiKey: resolveApiKey(matchedProvider.apiKey) ?? "",
    model: matchedModel.modelId,
    // opencode / ccb 引擎用 modelName 作为运行时模型标识（如 ANTHROPIC_MODEL 环境变量）。
    // 数据库 model.modelId 即用户配置的模型名（如 deepseek-v4-flash），直接透传。
    modelName: matchedModel.modelId,
    modalities: matchedModel.modalities ?? undefined,
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
      apiKey: resolveApiKey(providerRow.apiKey) ?? "",
      model: firstModel.modelId,
      modelName: firstModel.modelId,
      modalities: firstModel.modalities ?? undefined,
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

/**
 * 读取 Agent 显式绑定的 MCP，并保持与绑定顺序一致。
 *
 * AgentConfig 现在采用“显式勾选”语义，因此空绑定就代表不注入任何 MCP，
 * 这里不能再回退到组织下全部可用 MCP。
 */
async function loadAgentMcpServers(agentConfig: AgentConfigDetailWithAccess): Promise<McpServerRow[]> {
  const bindings = await db
    .select({ mcpServerId: agentConfigMcp.mcpServerId })
    .from(agentConfigMcp)
    .where(eq(agentConfigMcp.agentConfigId, agentConfig.id));
  if (bindings.length === 0) {
    return [];
  }

  const mcpIds = bindings.map((row) => row.mcpServerId);
  const mcpRows = await db.select().from(mcpServer).where(inArray(mcpServer.id, mcpIds));
  const mcpById = new Map(mcpRows.map((row) => [row.id, row]));
  const missingMcpIds = mcpIds.filter((mcpId) => !mcpById.has(mcpId));
  if (missingMcpIds.length > 0) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references missing MCP servers`,
      `[launch-spec-builder] missing mcp rows for agentConfig='${agentConfig.id}', missingMcpIds=${JSON.stringify(missingMcpIds)}, available=${JSON.stringify(
        summarizeRawMcpServers(mcpRows),
      )}`,
    );
  }

  const disabledMcpRows = mcpRows.filter((row) => !row.enabled);
  if (disabledMcpRows.length > 0) {
    throwInvalidConfig(
      `AgentConfig '${agentConfig.id}' references disabled MCP servers`,
      `[launch-spec-builder] disabled mcp rows for agentConfig='${agentConfig.id}', disabled=${JSON.stringify(summarizeRawMcpServers(disabledMcpRows))}`,
    );
  }

  return mcpIds.map((mcpId) => mcpById.get(mcpId) as McpServerRow);
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
    `[launch-spec-builder] buildLaunchSpec: agent='${agentConfig.name}', agentConfigId='${agentConfig.id}', modelId='${agentConfig.modelId ?? ""}', org='${agentConfig.organizationId}'`,
  );

  // Phase 1: 先并行拿到构造 launchSpec 的原始资源，确保错误尽早暴露。
  const [model, skillRows, rawMcpServers, knowledgeBindings] = await Promise.all([
    resolveModelConfig(agentConfig),
    loadAgentSkills(agentConfig),
    loadAgentMcpServers(agentConfig),
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
  const finalPrompt = composeAgentSystemPrompt(config.agentSystemPrompt, agentConfig.name, agentConfig.prompt);

  // Phase 3: 产出最终 launchSpec，此时所有关键资源都已经完成严格校验。
  // 调用 agent-memory service 判断是否启用 Hindsight（不查 extra.plugin）
  let processedExtra = (agentConfig.extra as Record<string, unknown> | null | undefined) ?? null;
  const ccbHindsightEnv: Record<string, string> = {};

  const enableMemory = await shouldEnableAgentMemory(agentConfig.id);
  if (enableMemory) {
    const hindsightUrl = process.env.HINDSIGHT_MCP_URL; // shouldEnableAgentMemory 已确保非空
    if (hindsightUrl) {
      let bankId: string | null = null;
      try {
        const rows = await db
          .select({ id: member.id })
          .from(member)
          .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
          .limit(1);
        bankId = rows[0]?.id ?? null;
      } catch (err) {
        logError(`[launch-spec-builder] failed to resolve memberId for Hindsight bankId: ${String(err)}`);
      }

      // OpenCode 路径：动态构建 plugin 列表（过滤掉旧 extra 中的 hindsight 条目，用动态构造的替换）
      const existingPlugins: Array<[string, Record<string, unknown>]> = (
        Array.isArray(processedExtra?.plugin)
          ? (processedExtra.plugin as Array<[string, unknown]>).filter(
              ([name]) => name !== "@konghayao/opencode-hindsight",
            )
          : []
      ) as Array<[string, Record<string, unknown>]>;

      existingPlugins.push([
        "@konghayao/opencode-hindsight",
        {
          ...HINDSIGHT_PLUGIN_DEFAULTS,
          hindsightApiUrl: hindsightUrl,
          ...(bankId ? { bankId } : {}),
        },
      ]);

      processedExtra = { ...(processedExtra ?? {}), plugin: existingPlugins };

      // CCB 路径：注入 Hindsight 环境变量到 launchSpec.env
      ccbHindsightEnv.HINDSIGHT_API_URL = hindsightUrl;
      ccbHindsightEnv.HINDSIGHT_LLM_PROVIDER = "claude-code";
      if (bankId) ccbHindsightEnv.HINDSIGHT_BANK_ID = bankId;
      const apiToken = process.env.HINDSIGHT_API_TOKEN;
      if (apiToken) ccbHindsightEnv.HINDSIGHT_API_TOKEN = apiToken;
    }
  }

  // 合并 extraEnv 和 CCB Hindsight 环境变量（调用方显式传入的同名变量优先）
  const extraEnv = input.extraEnv ?? {};
  const launchEnv = { ...ccbHindsightEnv, ...extraEnv };

  return {
    organizationId,
    userId,
    ...(environmentId ? { environmentId } : {}),
    env: launchEnv,
    agent: {
      name: agentConfig.name,
      prompt: finalPrompt,
      ...(processedExtra ? { extra: processedExtra } : {}),
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
      prompt: composeAgentSystemPrompt(config.agentSystemPrompt, "build"),
    },
    model: modelConfig,
    skills: [],
    mcpServers: [],
  };
}
