import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import * as configPg from "../../../services/config-pg";
import {
  InvalidKnowledgeBindingError,
  listAgentKnowledgeBindings,
  resolveAgentKnowledgePolicy,
  syncAgentKnowledgeBindings,
  type AgentKnowledgeConfig,
  type AgentKnowledgePolicy,
} from "../../../services/agent-knowledge";

const BUILT_IN_AGENTS = new Set(["build", "plan", "general", "explore", "title", "summary", "compaction"]);

// ── Permission 类型定义 ──
type PermissionAction = "ask" | "allow" | "deny";
type RuleBasedPermission = PermissionAction | Record<string, PermissionAction>;
type TogglePermission = PermissionAction;

type PermissionObjectConfig = {
  read?: RuleBasedPermission;
  edit?: RuleBasedPermission;
  glob?: RuleBasedPermission;
  grep?: RuleBasedPermission;
  list?: RuleBasedPermission;
  bash?: RuleBasedPermission;
  task?: RuleBasedPermission;
  external_directory?: RuleBasedPermission;
  lsp?: RuleBasedPermission;
  skill?: RuleBasedPermission;
  todowrite?: TogglePermission;
  question?: TogglePermission;
  webfetch?: TogglePermission;
  websearch?: TogglePermission;
  codesearch?: TogglePermission;
  doom_loop?: TogglePermission;
};

type PermissionConfig = PermissionAction | PermissionObjectConfig;

type AgentConfig = Record<string, unknown> & {
  knowledge?: AgentKnowledgeConfig | null;
};

const AGENT_SETTABLE_FIELDS = new Set([
  "model", "prompt", "steps", "mode", "permission",
  "variant", "temperature", "top_p", "disable", "hidden", "color", "description",
  "knowledge",
]);

function isValidAgentName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)
      && name.length >= 1 && name.length <= 64
      && !name.includes("--");
}

function isValidMode(mode: string): boolean {
  return ["primary", "subagent", "all"].includes(mode);
}

function isValidSteps(steps: number): boolean {
  return Number.isInteger(steps) && steps >= 1 && steps <= 200;
}

/** 将旧 tools 格式转换为 permission 格式 */
function toolsToPermission(tools: Record<string, boolean>): PermissionObjectConfig {
  const result: Record<string, PermissionAction> = {};
  for (const [key, val] of Object.entries(tools)) {
    result[key] = val ? "allow" : "deny";
  }
  return result as PermissionObjectConfig;
}

function validateAgentData(data: Record<string, unknown>): string | null {
  if (data.mode !== undefined && !isValidMode(data.mode as string)) return "INVALID_MODE";
  if (data.steps !== undefined && !isValidSteps(data.steps as number)) return "INVALID_STEPS";
  if (data.temperature !== undefined) {
    const t = data.temperature as number;
    if (typeof t !== "number" || t < 0 || t > 2) return "INVALID_TEMPERATURE";
  }
  if (data.top_p !== undefined) {
    const p = data.top_p as number;
    if (typeof p !== "number" || p < 0 || p > 1) return "INVALID_TOP_P";
  }
  if (data.color !== undefined) {
    const c = data.color as string;
    const PRESET_COLORS = ["primary", "secondary", "accent", "success", "warning", "error", "info"];
    const isHex = /^#[0-9a-fA-F]{6}$/.test(c);
    if (typeof c !== "string" || (!isHex && !PRESET_COLORS.includes(c))) return "INVALID_COLOR";
  }
  if (data.permission !== undefined && data.permission !== null) {
    if (typeof data.permission === "string") return "INVALID_PERMISSION";
    if (typeof data.permission !== "object" || Array.isArray(data.permission)) return "INVALID_PERMISSION";
  }
  if (data.knowledge !== undefined) {
    const error = validateKnowledgeConfig(data.knowledge);
    if (error) return error;
  }
  return null;
}

function normalizeKnowledgePolicy(value: AgentKnowledgePolicy | null | undefined) {
  const policy = resolveAgentKnowledgePolicy(value);
  return {
    searchFirst: policy.searchFirst,
    maxResults: policy.maxResults,
    defaultNamespaces: policy.defaultNamespaces,
  };
}

function normalizeKnowledgeConfig(value: unknown): AgentKnowledgeConfig | null {
  if (value == null) return null;
  const input = value as AgentKnowledgeConfig;
  return {
    knowledgeBaseIds: Array.from(
      new Set(
        (Array.isArray(input.knowledgeBaseIds) ? input.knowledgeBaseIds : [])
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean),
      ),
    ),
    policy: normalizeKnowledgePolicy(input.policy),
  };
}

function validateKnowledgeConfig(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "object") return "INVALID_KNOWLEDGE";

  const config = value as Record<string, unknown>;
  if (!Array.isArray(config.knowledgeBaseIds)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }
  if (config.knowledgeBaseIds.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    return "INVALID_KNOWLEDGE_BASE_IDS";
  }

  if (config.policy !== undefined && config.policy !== null) {
    if (typeof config.policy !== "object") {
      return "INVALID_KNOWLEDGE_POLICY";
    }
    const policy = config.policy as Record<string, unknown>;
    if (policy.searchFirst !== undefined && typeof policy.searchFirst !== "boolean") {
      return "INVALID_KNOWLEDGE_SEARCH_FIRST";
    }
    if (
      policy.maxResults !== undefined
      && (!Number.isInteger(policy.maxResults) || (policy.maxResults as number) < 1 || (policy.maxResults as number) > 20)
    ) {
      return "INVALID_KNOWLEDGE_MAX_RESULTS";
    }
    if (
      policy.defaultNamespaces !== undefined
      && (
        !Array.isArray(policy.defaultNamespaces)
        || policy.defaultNamespaces.some((item) => typeof item !== "string" || item.trim().length === 0)
      )
    ) {
      return "INVALID_KNOWLEDGE_DEFAULT_NAMESPACES";
    }
  }

  return null;
}

/** 将 PG 行数据映射为前端兼容的 agent 字段 */
function pgRowToAgentFields(row: typeof configPg extends { listAgentConfigs: (userId: string) => Promise<(infer T)[]> } ? T : never) {
  // tools → permission 兼容转换：PG 中不再有 tools，但保留接口
  let permission = (row as any).permission ?? null;
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

async function handleList(userId: string) {
  const agents = await configPg.listAgentConfigs(userId);
  const uc = await configPg.getUserConfig(userId);
  const defaultAgent = uc.defaultAgent ?? null;
  const list = await Promise.all(agents.map(async (a) => ({
    name: a.name,
    builtIn: BUILT_IN_AGENTS.has(a.name),
    model: a.model ?? null,
    mode: a.mode ?? null,
    description: a.description ?? null,
    color: a.color ?? null,
    knowledgeBaseCount: (await listAgentKnowledgeBindings(a.name)).length,
  })));
  return { success: true, data: { default_agent: defaultAgent, agents: list } };
}

async function handleGet(userId: string, name: string) {
  const agent = await configPg.getAgentConfig(userId, name);
  if (!agent) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };

  let permission = agent.permission ?? null;
  // tools→permission 兼容：旧数据可能只有 tools 没有 permission
  const tools = (agent as Record<string, unknown>).tools;
  if (permission == null && tools && typeof tools === "object" && !Array.isArray(tools)) {
    permission = toolsToPermission(tools as Record<string, boolean>);
  }

  return {
    success: true,
    data: {
      name,
      builtIn: BUILT_IN_AGENTS.has(name),
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
    },
  };
}

async function handleSet(userId: string, name: string, data: Record<string, unknown>) {
  const validation = validateAgentData(data);
  if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

  // 白名单过滤
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.has(key)) {
      filtered[key] = key === "knowledge" ? normalizeKnowledgeConfig(value) : value;
    }
  }

  // 检查 agent 是否存在
  const existing = await configPg.getAgentConfig(userId, name);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };

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

  await configPg.updateAgentConfig(userId, name, updateData);
  await syncAgentKnowledgeBindings(userId, name, filtered.knowledge as AgentKnowledgeConfig | null | undefined);
  return { success: true, data: { name, ...filtered } };
}

async function handleCreate(userId: string, name: string, data: Record<string, unknown>) {
  if (!isValidAgentName(name)) {
    return { success: false, error: { code: "VALIDATION_ERROR", message: "Invalid agent name: must be 1-64 lowercase alphanumeric chars with single hyphens" } };
  }
  const validation = validateAgentData(data);
  if (validation) return { success: false, error: { code: "VALIDATION_ERROR", message: validation } };

  // 白名单过滤
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (AGENT_SETTABLE_FIELDS.has(key)) {
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
  const existing = await configPg.getAgentConfig(userId, name);
  if (existing) return { success: false, error: { code: "ALREADY_EXISTS", message: `Agent '${name}' already exists` } };

  await configPg.createAgentConfig(userId, name, pgData);
  await syncAgentKnowledgeBindings(userId, name, filtered.knowledge as AgentKnowledgeConfig | null | undefined);
  return { success: true, data: { name } };
}

async function handleDelete(userId: string, name: string) {
  if (BUILT_IN_AGENTS.has(name)) {
    return { success: false, error: { code: "FORBIDDEN", message: `Cannot delete built-in agent '${name}'` } };
  }
  const deleted = await configPg.deleteAgentConfig(userId, name);
  if (!deleted) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };
  return { success: true };
}

async function handleSetDefault(userId: string, name: string) {
  const agent = await configPg.getAgentConfig(userId, name);
  if (!agent) return { success: false, error: { code: "NOT_FOUND", message: `Agent '${name}' not found` } };
  await configPg.setUserConfig(userId, { defaultAgent: name });
  return { success: true, data: { default_agent: name } };
}

const app = new Elysia({ name: "web-config-agents", prefix: "/web" })
  .use(authGuardPlugin);

app.post("/config/agents", async ({ store, body, error }) => {
  const user = store.user!;
  const b = (body as any) ?? {};
  const { action, name, data } = { action: b.action ?? "", name: b.name, data: b.data as Record<string, unknown> | undefined };
  try {
    switch (action) {
      case "list": return await handleList(user.id);
      case "get": return await handleGet(user.id, name!);
      case "set": return await handleSet(user.id, name!, data!);
      case "create": return await handleCreate(user.id, name!, data!);
      case "delete": return await handleDelete(user.id, name!);
      case "set_default": return await handleSetDefault(user.id, name!);
      default: return error(400, { success: false, error: { code: "VALIDATION_ERROR", message: `Unknown action '${action}'` } });
    }
  } catch (error_) {
    if (
      error_ instanceof InvalidKnowledgeBindingError
      || (typeof error_ === "object" && error_ !== null && "code" in error_ && (error_ as { code?: string }).code === "INVALID_KNOWLEDGE_BINDINGS")
    ) {
      const message = error_ instanceof Error ? error_.message : "知识库绑定无效";
      return error(400, { success: false, error: { code: "INVALID_KNOWLEDGE_BINDINGS", message } });
    }
    throw error_;
  }
}, { sessionAuth: true });

export default app;
