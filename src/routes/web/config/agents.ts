import Elysia from "elysia";
import { type AuthContext, authGuardPlugin } from "../../../plugins/auth";
import {
  type AgentKnowledgeConfig,
  InvalidKnowledgeBindingError,
  listAgentKnowledgeBindingsById,
  syncAgentKnowledgeBindingsById,
} from "../../../services/agent-knowledge";
import {
  AGENT_SETTABLE_FIELDS,
  isBuiltInAgent,
  normalizeKnowledgeConfig,
  toolsToPermission,
  validateAgentData,
} from "../../../services/config/agent-config";
import * as configPg from "../../../services/config-pg";
import {
  configError,
  configNotFound,
  configSuccess,
  configValidationError,
  isValidResourceName,
} from "../../../services/config-utils";

/** 将 PG 行数据映射为前端兼容的 agent 字段 */
function pgRowToAgentFields(
  row: typeof configPg extends { listAgentConfigs: (ctx: AuthContext) => Promise<(infer T)[]> } ? T : never,
) {
  // tools → permission 兼容转换：PG 中不再有 tools，但保留接口
  const permission = (row as any).permission ?? null;
  return {
    name: (row as any).name,
    model: (row as any).model ?? null,
    mode: (row as any).mode ?? null,
    description: (row as any).description ?? null,
    color: (row as any).color ?? null,
    disable: (row as any).disable ?? false,
    hidden: (row as any).hidden ?? false,
    steps: (row as any).steps ?? null,
    variant: (row as any).variant ?? null,
    temperature: (row as any).temperature ?? null,
    top_p: (row as any).topP ?? null,
    prompt: (row as any).prompt ?? null,
    permission,
    knowledge: (row as any).knowledge ?? null,
  };
}

async function handleList(ctx: AuthContext) {
  const agents = await configPg.listAgentConfigs(ctx);
  const uc = await configPg.getUserConfig(ctx);
  const defaultAgent = uc.defaultAgent ?? null;
  const list = await Promise.all(
    agents.map(async (a) => ({
      id: a.id,
      name: a.name,
      builtIn: isBuiltInAgent(a.name),
      model: a.model ?? null,
      mode: a.mode ?? null,
      description: a.description ?? null,
      color: a.color ?? null,
      knowledgeBaseCount: (await listAgentKnowledgeBindingsById(a.id)).length,
    })),
  );
  return configSuccess({ default_agent: defaultAgent, agents: list });
}

async function handleGet(ctx: AuthContext, name: string) {
  const agent = await configPg.getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);

  let permission = agent.permission ?? null;
  // tools→permission 兼容：旧数据可能只有 tools 没有 permission
  const tools = (agent as Record<string, unknown>).tools;
  if (permission == null && tools && typeof tools === "object" && !Array.isArray(tools)) {
    permission = toolsToPermission(tools as Record<string, boolean>);
  }

  return configSuccess({
    name,
    builtIn: isBuiltInAgent(name),
    model: agent.model ?? null,
    prompt: agent.prompt ?? null,
    steps: agent.steps ?? null,
    mode: agent.mode ?? null,
    permission,
    variant: agent.variant ?? null,
    temperature: agent.temperature ?? null,
    top_p: agent.topP ?? null,
    disable: agent.disable ?? false,
    hidden: agent.hidden ?? false,
    color: agent.color ?? null,
    description: agent.description ?? null,
    knowledge: normalizeKnowledgeConfig(agent.knowledge ?? null),
  });
}

async function handleSet(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  const validation = validateAgentData(data);
  if (validation) return configValidationError(validation);

  // 白名单过滤
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.includes(key as (typeof AGENT_SETTABLE_FIELDS)[number])) {
      filtered[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
  }

  // 检查 agent 是否存在
  const existing = await configPg.getAgentConfig(ctx, name);
  if (!existing) return configNotFound(`Agent '${name}' not found`);

  // 清除 null 值字段，映射 snake_case → camelCase
  const updateData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filtered)) {
    if (key === "permission" && value == null) {
      updateData[key] = null;
    } else if (key === "knowledge" && value == null) {
      updateData[key] = null;
    } else if (key === "top_p") {
      updateData["topP"] = value;
    } else {
      updateData[key] = value;
    }
  }

  await configPg.updateAgentConfig(ctx, name, updateData);
  const updatedAgent = await configPg.getAgentConfig(ctx, name);
  if (updatedAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      updatedAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
  }
  return configSuccess({ name, ...filtered });
}

async function handleCreate(ctx: AuthContext, name: string, data: Record<string, unknown>) {
  if (!isValidResourceName(name)) {
    return configValidationError("Invalid agent name: must be 1-64 lowercase alphanumeric chars with single hyphens");
  }
  const validation = validateAgentData(data);
  if (validation) return configValidationError(validation);

  // 白名单过滤
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.includes(key as (typeof AGENT_SETTABLE_FIELDS)[number])) {
      filtered[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
  }
  if (filtered.permission == null) delete filtered.permission;

  // 映射 snake_case → camelCase for PG storage
  const pgData: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(filtered)) {
    if (key === "top_p") {
      pgData["topP"] = value;
    } else {
      pgData[key] = value;
    }
  }

  // 检查是否已存在
  const existing = await configPg.getAgentConfig(ctx, name);
  if (existing) return configError("ALREADY_EXISTS", `Agent '${name}' already exists`);

  await configPg.createAgentConfig(ctx, name, pgData);
  const createdAgent = await configPg.getAgentConfig(ctx, name);
  if (createdAgent) {
    await syncAgentKnowledgeBindingsById(
      ctx.organizationId,
      createdAgent.id,
      filtered.knowledge as AgentKnowledgeConfig | null | undefined,
    );
  }
  return configSuccess({ name });
}

async function handleDelete(ctx: AuthContext, name: string) {
  if (isBuiltInAgent(name)) {
    return configError("FORBIDDEN", `Cannot delete built-in agent '${name}'`);
  }
  const deleted = await configPg.deleteAgentConfig(ctx, name);
  if (!deleted) return configNotFound(`Agent '${name}' not found`);
  return configSuccess(null);
}

async function handleSetDefault(ctx: AuthContext, name: string) {
  const agent = await configPg.getAgentConfig(ctx, name);
  if (!agent) return configNotFound(`Agent '${name}' not found`);
  await configPg.setUserConfig(ctx, { defaultAgent: name });
  return configSuccess({ default_agent: name });
}

import { ConfigBodySchema } from "../../../schemas/config.schema";

const app = new Elysia({ name: "web-config-agents", prefix: "/web" }).use(authGuardPlugin).model({
  "config-body": ConfigBodySchema,
});

app.post(
  "/config/agents",
  async ({ store, body, error, request }: any) => {
    const authCtx = store.authContext!;
    const b = (body as any) ?? {};
    const { action, name, data } = {
      action: b.action ?? "",
      name: b.name,
      data: b.data as Record<string, unknown> | undefined,
    };
    // get/set/create/delete/set_default 都需要 name
    if (action !== "list" && !name) {
      return error(400, configValidationError("Missing 'name' field"));
    }
    try {
      switch (action) {
        case "list":
          return await handleList(authCtx);
        case "get":
          return await handleGet(authCtx, name!);
        case "set":
          return await handleSet(authCtx, name!, data!);
        case "create":
          return await handleCreate(authCtx, name!, data!);
        case "delete":
          return await handleDelete(authCtx, name!);
        case "set_default":
          return await handleSetDefault(authCtx, name!);
        default:
          return error(400, configValidationError(`Unknown action '${action}'`));
      }
    } catch (error_) {
      if (
        error_ instanceof InvalidKnowledgeBindingError ||
        (typeof error_ === "object" &&
          error_ !== null &&
          "code" in error_ &&
          (error_ as { code?: string }).code === "INVALID_KNOWLEDGE_BINDINGS")
      ) {
        const message = error_ instanceof Error ? error_.message : "知识库绑定无效";
        return error(400, configError("INVALID_KNOWLEDGE_BINDINGS", message));
      }
      throw error_;
    }
  },
  { sessionAuth: true, body: "config-body", detail: { tags: ["Config"], summary: "Agent 配置管理" } },
);

export default app;
