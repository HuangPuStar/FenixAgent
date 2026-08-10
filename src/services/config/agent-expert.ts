/**
 * agent-expert.ts — 专家库（agent_expert）业务编排层。
 *
 * 领域规则：
 * - 内置专家（organizationId="system"）对所有组织只读，写操作抛 AppError("FORBIDDEN")；
 * - 组织自建专家按 organizationId 隔离；
 * - delete 语义：system 行（内置）抛 FORBIDDEN——内置专家的软删除（disabled）由
 *   模板同步/refresh 按决策 D3 管理，不开放给用户写接口；组织自建行物理删除（DB 级联清理引用）；
 * - duplicate 复制到本组织（重名自动追加 -copy 后缀），是内置专家被禁用后的恢复路径；
 * - 外部输入全部校验（name 防路径穿越、mode/steps/temperature/permission 范围）。
 */
import { AppError } from "../../errors";
import type { AuthContext } from "../../plugins/auth";
import { findModelsByProviderIdsAndEngineId } from "../../repositories/agent-config";
import {
  type AgentExpertInsert,
  type AgentExpertRow,
  createExpert,
  deleteExpert,
  getExpertById,
  getExpertByName,
  getExpertsByIds,
  listVisibleExperts,
  setExpertDisabled,
  updateExpert,
  upsertExpertByOrgName,
} from "../../repositories/agent-expert";
import { sanitizeExpertName } from "../agent-expert-sync";
import { isValidMode, isValidSteps } from "./agent-config";
import { listReadableProviders } from "./provider";

export const SYSTEM_ORGANIZATION_ID = "system";

/** 专家可写字段（与 agent_expert 表列一一对应；id/organizationId/builtin/disabled 由服务端控制） */
const EXPERT_SETTABLE_FIELDS = [
  "name",
  "description",
  "prompt",
  "skills",
  "model",
  "mode",
  "temperature",
  "steps",
  "permission",
  "extra",
] as const;

export type ExpertSettableField = (typeof EXPERT_SETTABLE_FIELDS)[number];

export interface AgentExpertView {
  id: string;
  name: string;
  description: string | null;
  prompt: string;
  skills: string[];
  model: string | null;
  mode: string;
  temperature: number | null;
  steps: number | null;
  permission: unknown;
  builtin: boolean;
  disabled: boolean;
  organizationId: string;
  /** ISO 字符串（AgentExpertSchema 声明 z.string()，Elysia 响应校验在序列化前执行，Date 会被判非法） */
  createdAt: string;
  updatedAt: string;
}

function toView(row: AgentExpertRow): AgentExpertView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    prompt: row.prompt,
    skills: Array.isArray(row.skills) ? (row.skills as string[]) : [],
    model: row.model,
    mode: row.mode,
    temperature: row.temperature,
    steps: row.steps,
    permission: row.permission,
    builtin: row.builtin,
    disabled: row.disabled,
    organizationId: row.organizationId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * 校验专家输入数据。返回错误信息字符串（null 表示通过）。
 * 规则与 md frontmatter 语义对齐（模式/步数/温度/权限均为 subagent 定义字段）。
 */
export function validateExpertData(data: Record<string, unknown>): string | null {
  if (data.name !== undefined) {
    if (typeof data.name !== "string" || !sanitizeExpertName(data.name)) {
      return "Invalid expert name: must be 1-64 characters (letters, numbers, spaces, single hyphens)";
    }
  }
  if (data.prompt !== undefined && (typeof data.prompt !== "string" || data.prompt.trim().length === 0)) {
    return "Invalid expert prompt: must be a non-empty string";
  }
  if (data.skills !== undefined) {
    if (!Array.isArray(data.skills) || data.skills.some((s) => typeof s !== "string" || s.trim().length === 0)) {
      return "Invalid expert skills: must be a string array of skill names";
    }
  }
  if (data.model !== undefined && data.model !== null) {
    if (typeof data.model !== "string" || data.model.trim().length === 0) {
      return "Invalid expert model: must be a provider/model identifier string";
    }
  }
  if (data.mode !== undefined) {
    if (typeof data.mode !== "string" || !isValidMode(data.mode))
      return "Invalid expert mode: must be primary|subagent|all";
  }
  if (data.temperature !== undefined && data.temperature !== null) {
    if (typeof data.temperature !== "number" || data.temperature < 0 || data.temperature > 2) {
      return "Invalid expert temperature: must be a number in [0, 2]";
    }
  }
  if (data.steps !== undefined && data.steps !== null) {
    if (typeof data.steps !== "number" || !isValidSteps(data.steps)) {
      return "Invalid expert steps: must be an integer in [1, 1000]";
    }
  }
  if (data.permission !== undefined && data.permission !== null) {
    if (typeof data.permission === "string") return "Invalid expert permission: must be an object";
    if (typeof data.permission !== "object" || Array.isArray(data.permission)) {
      return "Invalid expert permission: must be an object";
    }
  }
  if (data.extra !== undefined && data.extra !== null) {
    if (typeof data.extra !== "object" || Array.isArray(data.extra)) return "Invalid expert extra: must be an object";
  }
  return null;
}

/** 将白名单字段映射为 insert/set 载荷（非法字段静默忽略，路由层已做请求级校验） */
function buildSetFromData(data: Record<string, unknown>): Partial<AgentExpertInsert> {
  const set: Partial<AgentExpertInsert> = {};
  for (const field of EXPERT_SETTABLE_FIELDS) {
    if (data[field] !== undefined) {
      (set as Record<string, unknown>)[field] = data[field] ?? null;
    }
  }
  return set;
}

/** 列出当前组织可见专家（内置 + 本组织；默认排除 disabled） */
export async function listAgentExperts(
  ctx: AuthContext,
  options: { includeDisabled?: boolean } = {},
): Promise<AgentExpertView[]> {
  const rows = await listVisibleExperts(ctx.organizationId, options);
  return rows.map(toView);
}

/** 按 ID 读取专家；不可见（跨组织/不存在）返回 null */
export async function getVisibleAgentExpert(ctx: AuthContext, id: string): Promise<AgentExpertView | null> {
  const row = await getExpertById(id);
  if (!row) return null;
  if (row.organizationId !== SYSTEM_ORGANIZATION_ID && row.organizationId !== ctx.organizationId) return null;
  return toView(row);
}

/** 创建组织自建专家；同名已存在（本组织）抛 ALREADY_EXISTS */
export async function createAgentExpert(ctx: AuthContext, data: Record<string, unknown>): Promise<AgentExpertView> {
  const validation = validateExpertData(data);
  if (validation) throw new AppError(validation, "VALIDATION_ERROR", 400);

  const name = typeof data.name === "string" ? data.name.trim() : "";
  if (!sanitizeExpertName(name)) throw new AppError("Invalid expert name", "VALIDATION_ERROR", 400);
  const prompt = typeof data.prompt === "string" ? data.prompt : "";
  if (prompt.trim().length === 0) throw new AppError("Invalid expert prompt", "VALIDATION_ERROR", 400);

  // (organizationId, name) 唯一约束兜底重名；先查后插使重名返回稳定 409
  if (await getExpertByName(ctx.organizationId, name)) {
    throw new AppError(`Expert '${name}' already exists`, "ALREADY_EXISTS", 409);
  }

  const row = await createExpert({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    name,
    prompt,
    description: typeof data.description === "string" ? data.description : null,
    skills: Array.isArray(data.skills) ? (data.skills as string[]) : [],
    model: typeof data.model === "string" && data.model.length > 0 ? data.model : null,
    mode: typeof data.mode === "string" && isValidMode(data.mode) ? data.mode : "subagent",
    temperature: typeof data.temperature === "number" ? data.temperature : null,
    steps: typeof data.steps === "number" ? data.steps : null,
    permission: data.permission ?? null,
    builtin: false,
    disabled: false,
  });
  return toView(row);
}

/**
 * 更新专家。system 行（内置）抛 FORBIDDEN；跨组织行按不存在处理返回 null。
 */
export async function updateAgentExpert(
  ctx: AuthContext,
  id: string,
  data: Record<string, unknown>,
): Promise<AgentExpertView | null> {
  const existing = await getExpertById(id);
  if (!existing) return null;
  if (existing.organizationId === SYSTEM_ORGANIZATION_ID) {
    throw new AppError("Cannot modify built-in expert", "FORBIDDEN", 403);
  }
  if (existing.organizationId !== ctx.organizationId) return null;

  const validation = validateExpertData(data);
  if (validation) throw new AppError(validation, "VALIDATION_ERROR", 400);

  const set = buildSetFromData(data);
  const updated = await updateExpert(id, set);
  return updated ? toView(updated) : null;
}

/**
 * 删除专家：system 行（内置）抛 FORBIDDEN——内置专家的软删除（disabled）由模板同步
 * 按决策 D3 管理（文件删除 → disabled、恢复 → enabled），不开放用户写接口；
 * 组织自建 → 物理删除（DB 级联清理 agent_config_expert 引用）。
 * 跨组织行按不存在处理返回 null。
 */
export async function deleteAgentExpert(ctx: AuthContext, id: string): Promise<boolean> {
  const existing = await getExpertById(id);
  if (!existing) return false;
  if (existing.organizationId === SYSTEM_ORGANIZATION_ID) {
    throw new AppError("Cannot delete built-in expert", "FORBIDDEN", 403);
  }
  if (existing.organizationId !== ctx.organizationId) return false;
  return deleteExpert(id);
}

/** 软删除内置专家（仅内部同步/未来管理动作使用；路由对 system 行拒绝） */
export async function setBuiltinExpertDisabled(id: string, disabled: boolean): Promise<boolean> {
  return setExpertDisabled(id, disabled);
}

/**
 * 复制专家到本组织（内置专家恢复路径，决策 D3）：复制除 id/builtin 外的全部字段，
 * userId=当前用户；本组织已存在同名时自动追加 `-copy`/`-copy-2` 后缀。
 */
export async function duplicateAgentExpert(ctx: AuthContext, id: string): Promise<AgentExpertView | null> {
  const source = await getExpertById(id);
  if (!source) return null;
  // 只允许复制内置专家或本组织自建专家
  if (source.organizationId !== SYSTEM_ORGANIZATION_ID && source.organizationId !== ctx.organizationId) return null;

  let name = source.name;
  // 最多尝试 100 个候选名（-copy、-copy-2 …）；全部冲突（极端：同名后缀被占满）时
  // 保留原名交给唯一约束兜底前先显式报 409，避免裸 DB 错误冒泡成 500
  let candidateFound = false;
  for (let i = 1; i <= 100; i += 1) {
    const suffix = i === 1 ? "-copy" : `-copy-${i}`;
    const candidate = `${source.name.slice(0, 64 - suffix.length)}${suffix}`;
    if (sanitizeExpertName(candidate) && !(await getExpertByName(ctx.organizationId, candidate))) {
      name = candidate;
      candidateFound = true;
      break;
    }
  }
  if (!candidateFound) {
    throw new AppError(`Expert '${source.name}' copy name conflicts with existing experts`, "ALREADY_EXISTS", 409);
  }

  const row = await createExpert({
    organizationId: ctx.organizationId,
    userId: ctx.userId,
    name,
    prompt: source.prompt,
    description: source.description,
    skills: Array.isArray(source.skills) ? (source.skills as string[]) : [],
    model: source.model,
    mode: source.mode,
    temperature: source.temperature,
    steps: source.steps,
    permission: source.permission,
    builtin: false,
    disabled: false,
  });
  return toView(row);
}

/** 按 ID 批量读取（供 agents 路由组装 subagents 摘要；不校验可见性） */
export async function getExpertsByIdsForView(ids: string[]): Promise<AgentExpertView[]> {
  if (ids.length === 0) return [];
  const rows = await getExpertsByIds(ids);
  return rows.map(toView);
}

/**
 * 校验专家默认模型业务标识（providerName/modelId）在当前组织可解析（设计 §6）：
 * provider 按 name/displayName 匹配组织可读 provider，再在该 provider 下按
 * model.modelId（引擎标识）匹配模型。解析失败返回错误信息（null 表示通过），
 * 由引用它的 agent 创建/更新时明确报错，不静默 fallback。
 */
export async function validateExpertModelBusinessId(ctx: AuthContext, businessId: string): Promise<string | null> {
  const slashIndex = businessId.indexOf("/");
  if (slashIndex <= 0 || slashIndex === businessId.length - 1) {
    return `Invalid expert model identifier '${businessId}', expected providerName/modelId`;
  }
  const providerName = businessId.slice(0, slashIndex);
  const engineModelId = businessId.slice(slashIndex + 1);

  // 与前端模型下拉同源：仅当前组织可读（含共享）provider 下的模型
  const providers = await listReadableProviders(ctx);
  const matched = providers.filter((p) => p.name === providerName || p.displayName === providerName);
  if (matched.length === 0) {
    return `Expert default model '${businessId}' references unknown provider '${providerName}'`;
  }
  const rows = await findModelsByProviderIdsAndEngineId(
    matched.map((p) => p.id),
    engineModelId,
  );
  if (rows.length === 0) {
    return `Expert default model '${businessId}' references unknown model '${engineModelId}' for provider '${providerName}'`;
  }
  return null;
}

/** 内部同步入口（syncBuiltinExperts 之外供 refresh action 复用）；显式依赖注入便于测试 */
export { sanitizeExpertName, upsertExpertByOrgName };
