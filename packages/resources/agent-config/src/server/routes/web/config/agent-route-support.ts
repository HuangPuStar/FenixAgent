import type { ActorContext, IdentityDirectory, WebErrSchema } from "@fenix/platform-sdk";
import { AppError, ConflictError, ForbiddenError, ValidationError } from "@fenix/platform-sdk";
import type * as z from "zod/v4";
import type { AuthorizedAgentConfig } from "../../../facades/agent-config-facade";
import type { UserAgentPreferencesPort } from "../../../ports/user-agent-preferences";
import { getAgentConfigModule } from "../../../runtime";
import {
  AgentMutationBodySchema,
  AgentNameQuerySchema,
  type AgentTemplatesResponse,
  AgentTemplatesResponseSchema,
  DeleteAgentResponseSchema,
  RestartAgentResponseSchema,
  SetDefaultAgentRequestSchema,
  UpdateAgentRequestSchema,
} from "../../../schemas/config.schema";
import { applyAgentBindings, readAgentBindingRequest } from "../../../services/agent-bindings";
import { buildAgentRelatedResourceView } from "../../../services/agent-related-resources";
import { loadAgentTemplates } from "../../../services/agent-templates";
import {
  isBuiltInAgent,
  isValidAgentName,
  normalizeKnowledgeConfig,
  resolveAgentNode,
  toAgentConfigWriteData,
  validateAgentData,
} from "../../../services/config/agent-config";

/**
 * `/web/config/agents` 的协议层公共设施：错误映射、主体提取与视图映射。
 *
 * 与 mcp / skill 的同名路由保持同一套 `/web` 约定：错误码映射到**声明过的**状态码、视图返回
 * `scope + access`（决策 D2），组织名作为可选展示字段由身份目录批量解析。
 *
 * 应用编排（授权、资源解析、绑定同步、实例停止）全部经 `AgentConfigServerModule`：本文件不导入任何
 * 资源包，也不判断组织、角色或 `visibility`。
 */

export type WebErrorBody = z.infer<typeof WebErrSchema>;

/** handler 的返回形状：成功体或需要转成响应标记的错误体。 */
export type WebHandlerResult = { success: true; data: Record<string, unknown> | null } | WebErrorBody;

/** 已知错误码 → `/web` 声明过的状态码；未列出的码一律 400，避免返回未声明的状态码。 */
const AGENT_ERROR_STATUS: Readonly<Record<string, number>> = {
  UNAUTHORIZED: 401,
  VALIDATION_ERROR: 400,
  INVALID_KNOWLEDGE_BINDINGS: 400,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
};

export function buildWebErrorBody(code: string, message: string): WebErrorBody {
  return { success: false, error: { code, message } };
}

/**
 * 把抛出的错误映射为 `/web` 错误体。
 *
 * 两类来源都要认：宿主 `AppError`（状态码与码直接取其 `statusCode` / `code`），以及资源包自定义
 * 的带 `code` 字段的错误（knowledge 的 `InvalidKnowledgeBindingError` 就是这一类，`code` 为
 * `INVALID_KNOWLEDGE_BINDINGS`，不是 `AppError` 子类）。其余错误返回 null，调用方原样上抛
 * （500），不把存储或装配故障伪装成协议错误。
 */
function mapThrownError(error_: unknown): { status: number; code: string; message: string } | null {
  if (error_ instanceof AppError) {
    return { status: error_.statusCode, code: error_.code, message: error_.message };
  }
  const code = typeof error_ === "object" && error_ !== null ? (error_ as { code?: unknown }).code : undefined;
  if (typeof code === "string" && AGENT_ERROR_STATUS[code] !== undefined) {
    return {
      status: AGENT_ERROR_STATUS[code],
      code,
      message: error_ instanceof Error ? error_.message : "未知错误",
    };
  }
  return null;
}

/**
 * 执行 handler：取主体 → 执行 → 把错误映射为 `/web` 响应。
 *
 * 没有主体（未绑定组织的 API Key 等）一律 401：组织资源无法在没有组织上下文时被解析。
 */
export async function runWebHandler(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  status: any,
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store 类型未完全可表达
  store: any,
  handler: (actor: ActorContext) => Promise<WebHandlerResult>,
): Promise<WebHandlerResult> {
  const actor = store.actor as ActorContext | null;
  if (!actor) {
    return status(401, buildWebErrorBody("UNAUTHORIZED", "请求缺少组织上下文"));
  }
  try {
    const result = await handler(actor);
    if (result.success) return result;
    return status(AGENT_ERROR_STATUS[result.error.code ?? ""] ?? 400, result);
  } catch (error_) {
    const mapped = mapThrownError(error_);
    if (mapped) return status(mapped.status, buildWebErrorBody(mapped.code, mapped.message));
    throw error_;
  }
}

/** 批量解析归属组织名称；名录缺失时字段整体省略，不补空串。 */
async function resolveOrganizationNames(
  identity: IdentityDirectory,
  organizationIds: readonly (string | undefined)[],
): Promise<ReadonlyMap<string, string>> {
  const ids = [...new Set(organizationIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (ids.length === 0) return new Map();
  return identity.listOrganizationNames(ids);
}

/**
 * 展示字段：归属组织名称（有则加，无则整字段省略）。
 *
 * `scope.organizationId` 不存在时（个人资源）没有归属组织可展示，与名录不可用时一致地省略字段，
 * 让前端 `getAgentDisplayName` 回退为裸名称。
 */
async function resolveOrganizationName(
  identity: IdentityDirectory,
  organizationId: string | undefined,
): Promise<string | undefined> {
  return (await resolveOrganizationNames(identity, [organizationId])).get(organizationId ?? "");
}

/**
 * 用户偏好读写所需的组织维度上下文。
 *
 * `user_config` 按组织一行存储，因此偏好读写只需要组织与用户标识；没有 active organization 时
 * 无法定位该行，返回 null 由调用方转成 401。读写本身经宿主注入的
 * {@link UserAgentPreferencesPort}（该表属身份族，不归本包）。
 */
function toUserConfigSubject(actor: ActorContext): { organizationId: string; userId: string } | null {
  const organizationId = actor.activeOrganizationId;
  if (organizationId === undefined) return null;
  return { organizationId, userId: actor.userId };
}

function unauthorized(): WebHandlerResult {
  return buildWebErrorBody("UNAUTHORIZED", "请求缺少组织上下文");
}

/** 写路径的返回片段：名称 + 归属范围 + 有效动作（+ 归属组织展示名）。 */
async function toSaveResult(agent: AuthorizedAgentConfig, organizationName: string | undefined) {
  return {
    name: agent.name,
    id: agent.id,
    scope: agent.scope,
    access: agent.access,
    ...(organizationName === undefined ? {} : { organizationName }),
  };
}

/**
 * 列表视图：展示字段 + 绑定数量 + 归属范围 + 有效动作。
 *
 * `knowledgeBaseCount` 复用已经取出的绑定集合，不再单独查一次绑定表。
 */
async function toWebAgentItem(
  agent: AuthorizedAgentConfig,
  organizationName: string | undefined,
): Promise<Record<string, unknown>> {
  const { associations } = getAgentConfigModule();
  const [skillIds, mcpIds, siteAppIds, knowledgeBindings] = await Promise.all([
    associations.listSkillIds(agent.id),
    associations.listMcpIds(agent.id),
    associations.listSiteAppIds(agent.id),
    associations.listKnowledgeBindings(agent.id),
  ]);
  const agentNode = resolveAgentNode(agent) ?? {};
  const relatedResources = await buildAgentRelatedResourceView({
    id: agent.id,
    organizationId: agent.organizationId,
    modelId: agent.modelId ?? null,
    agentNode,
    skillIds,
    mcpIds,
    siteAppIds,
    knowledgeBaseIds: knowledgeBindings.map((binding) => binding.knowledgeBaseId),
  });

  return {
    id: agent.id,
    name: agent.name,
    builtIn: isBuiltInAgent(agent.name),
    model: agent.model ?? null,
    modelId: agent.modelId ?? null,
    modelLabel: relatedResources.modelLabel,
    description: agent.description ?? null,
    agentNode,
    knowledgeBaseCount: knowledgeBindings.length,
    skillLabels: relatedResources.skills,
    scope: agent.scope,
    access: agent.access,
    ...(organizationName === undefined ? {} : { organizationName }),
  };
}

/** 构建 agent 列表视图，并补齐前端展示依赖的资源标签与当前用户的默认 Agent。 */
async function handleList(actor: ActorContext, preferences: UserAgentPreferencesPort): Promise<WebHandlerResult> {
  const subject = toUserConfigSubject(actor);
  if (!subject) return unauthorized();

  const { facade, identity } = getAgentConfigModule();
  const { items } = await facade.list(actor);
  const organizationNames = await resolveOrganizationNames(
    identity,
    items.map((item) => item.scope.organizationId),
  );
  const userConfig = await preferences.read(subject);
  const agents = await Promise.all(
    items.map((item) => toWebAgentItem(item, organizationNames.get(item.scope.organizationId ?? ""))),
  );

  return { success: true, data: { default_agent: userConfig.defaultAgent ?? null, agents } };
}

/** 读取单个 agent 详情，保留原接口返回结构以兼容现有前端状态。 */
async function handleGet(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const { facade, identity, associations } = getAgentConfigModule();
  const agent = await facade.get(actor, nameOrKey);
  if (!agent) return buildWebErrorBody("NOT_FOUND", `Agent '${nameOrKey}' not found`);

  const [skillIds, mcpIds, siteAppIds, knowledgeBindings, knowledge, enableMemory, organizationName] =
    await Promise.all([
      associations.listSkillIds(agent.id),
      associations.listMcpIds(agent.id),
      associations.listSiteAppIds(agent.id),
      associations.listKnowledgeBindings(agent.id),
      associations.getKnowledge(agent.id),
      associations.isMemoryEnabled(agent.id),
      resolveOrganizationName(identity, agent.scope.organizationId),
    ]);
  const agentNode = resolveAgentNode(agent) ?? {};
  const relatedResources = await buildAgentRelatedResourceView({
    id: agent.id,
    organizationId: agent.organizationId,
    modelId: agent.modelId ?? null,
    agentNode,
    skillIds,
    mcpIds,
    siteAppIds,
    knowledgeBaseIds: knowledgeBindings.map((binding) => binding.knowledgeBaseId),
  });

  return {
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      builtIn: isBuiltInAgent(agent.name),
      model: agent.model ?? null,
      modelId: agent.modelId ?? null,
      prompt: agent.prompt ?? null,
      description: agent.description ?? null,
      extra: agent.extra ?? null,
      knowledge: normalizeKnowledgeConfig(knowledge ?? null),
      agentNode,
      enableMemory,
      skillIds,
      mcpIds,
      siteAppIds,
      relatedResources,
      scope: agent.scope,
      access: agent.access,
      ...(organizationName === undefined ? {} : { organizationName }),
    },
  };
}

/** 更新 agent 配置，并同步 knowledge / skills / MCP 等关联资源。 */
async function handleSet(
  actor: ActorContext,
  nameOrKey: string,
  data: Record<string, unknown>,
): Promise<WebHandlerResult> {
  const validation = validateAgentData(data);
  if (validation) throw new ValidationError(validation);

  // enableMemory（记忆开关）与 publicReadable（公开受众）都不是 agent_config 的可写列：
  // 前者在 memory 资源包的配置里，后者经 Facade 的 setVisibility 单独校验后写入归属列。
  const enableMemory = typeof data.enableMemory === "boolean" ? data.enableMemory : undefined;
  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;

  const { facade, associations } = getAgentConfigModule();
  const agent = await facade.update(actor, nameOrKey, toAgentConfigWriteData(data), { publicReadable });
  if (enableMemory !== undefined) {
    await associations.setMemoryEnabled(agent.id, enableMemory);
  }
  await applyAgentBindings({ agentConfigId: agent.id, request: readAgentBindingRequest(data), actor });

  return {
    success: true,
    data: await toSaveResult(agent, await resolveAgentOrganizationName(agent.scope.organizationId)),
  };
}

/** 创建 agent 配置，并在创建后补齐所有关联资源绑定。 */
async function handleCreate(
  actor: ActorContext,
  name: string,
  data: Record<string, unknown>,
): Promise<WebHandlerResult> {
  if (!isValidAgentName(name)) {
    throw new ValidationError("Invalid agent name: must be 1-64 characters (letters, numbers, spaces, single hyphens)");
  }
  const validation = validateAgentData(data);
  if (validation) throw new ValidationError(validation);

  const enableMemory = typeof data.enableMemory === "boolean" ? data.enableMemory : undefined;
  const publicReadable = typeof data.publicReadable === "boolean" ? data.publicReadable : undefined;

  const { facade, associations } = getAgentConfigModule();
  // 同名检查必须在创建之前：仓储的写入是同组织同名的幂等 upsert，把重复创建留给它会把"创建已存在
  // 的 Agent"静默变成一次更新。
  //
  // 判定口径是**归属组织内**（`existsInOrganization`），与 `create` 的 upsert 冲突目标
  // `(organization_id, name)` 一致。这里不能用读取的可见集合（`facade.get`）：可见集合还包含"任何
  // 组织的 public 资源"和"我是成员的其他组织的资源"，用它预检会把"别的组织有一个我能看到的同名
  // Agent"误判成本组织冲突，让本组织的合法创建返回 409（迁移前的 `getAgentConfig` 就是这种宽口径，
  // 控制台上确实表现为"组织里没有这个 Agent 却提示已存在"）。
  if (await facade.existsInOrganization(actor, name)) {
    throw new ConflictError(`Agent '${name}' already exists`);
  }

  const agent = await facade.create(actor, {
    name,
    data: toAgentConfigWriteData(data),
    ...(publicReadable === undefined ? {} : { publicReadable }),
  });
  if (enableMemory !== undefined) {
    await associations.setMemoryEnabled(agent.id, enableMemory);
  }
  await applyAgentBindings({ agentConfigId: agent.id, request: readAgentBindingRequest(data), actor });

  return {
    success: true,
    data: await toSaveResult(agent, await resolveAgentOrganizationName(agent.scope.organizationId)),
  };
}

/** 解析资源归属组织展示名；身份名录只在这里被读取，视图构造不自行查名录。 */
async function resolveAgentOrganizationName(organizationId: string | undefined): Promise<string | undefined> {
  return resolveOrganizationName(getAgentConfigModule().identity, organizationId);
}

/** 重启该 Agent 绑定 Environment 下的持久 Instance runtime，Instance 记录保持不变。 */
async function handleRestart(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  const result = await getAgentConfigModule().facade.restartInstances(actor, nameOrKey);
  return { success: true, data: { ...result } };
}

/** 删除 agent，内置 agent 永远不可删除。 */
async function handleDelete(actor: ActorContext, nameOrKey: string): Promise<WebHandlerResult> {
  if (isBuiltInAgent(nameOrKey)) {
    throw new ForbiddenError(`Cannot delete built-in agent '${nameOrKey}'`);
  }
  // 不可见（404）与可见但无 `delete` 动作（403）都由 Facade 抛出宿主错误类。
  await getAgentConfigModule().facade.remove(actor, nameOrKey);
  return { success: true, data: null };
}

/** 设置当前用户的默认 agent。 */
async function handleSetDefault(
  actor: ActorContext,
  nameOrKey: string,
  preferences: UserAgentPreferencesPort,
): Promise<WebHandlerResult> {
  const subject = toUserConfigSubject(actor);
  if (!subject) return unauthorized();

  const { facade, identity } = getAgentConfigModule();
  const agent = await facade.get(actor, nameOrKey);
  if (!agent) return buildWebErrorBody("NOT_FOUND", `Agent '${nameOrKey}' not found`);

  await preferences.write(subject, { defaultAgent: agent.name });
  const organizationName = await resolveOrganizationName(identity, agent.scope.organizationId);
  return {
    success: true,
    data: {
      default_agent: agent.name,
      scope: agent.scope,
      access: agent.access,
      ...(organizationName === undefined ? {} : { organizationName }),
    },
  };
}

/**
 * 模板列表响应。
 *
 * 返回精确类型而不是宽泛的 {@link WebHandlerResult}：模板形状由模板文件解析决定，不受授权视图影响，
 * 路由因此能按 `agent-templates-response` 精确校验 OpenAPI 文档。
 */
function handleTemplates(): AgentTemplatesResponse {
  return { success: true, data: { templates: loadAgentTemplates() } };
}

/**
 * 路由模型登记。
 *
 * 只登记请求侧、重启/删除响应与模板响应的精确 schema：其余成功响应按决策 D2 返回 `scope + access`，
 * 其形状由授权视图决定而不是由本包声明的字段清单决定，路由侧统一用宽松对象承接。
 */
export const agentRouteModels = {
  "agent-name-query": AgentNameQuerySchema,
  "agent-mutation-body": AgentMutationBodySchema,
  "agent-update-body": UpdateAgentRequestSchema,
  "agent-set-default-body": SetDefaultAgentRequestSchema,
  "agent-templates-response": AgentTemplatesResponseSchema,
  "agent-restart-response": RestartAgentResponseSchema,
  "agent-delete-response": DeleteAgentResponseSchema,
};

export {
  handleCreate,
  handleDelete,
  handleGet,
  handleList,
  handleRestart,
  handleSet,
  handleSetDefault,
  handleTemplates,
};
