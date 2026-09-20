import { getBoundAgentRuntime } from "@fenix/agent-runtime/runtime";
import { prodViewRepo } from "../repositories/prod-view";
import type { CreateProdViewInput, UpdateProdViewInput } from "../schemas/prod-view.schema";

/**
 * 本模块需要的最小调用者身份。
 *
 * 只取用到的两个字段，不 import 宿主 `AuthContext`（那是 `apps/server` 协议层的类型，包一旦依赖它
 * 就无法独立构建）：组织边界来自 `organizationId`（每条查询的组织谓词），记录归属来自 `userId`
 * （`createdBy`，以及视图载体——只属于该用户的持久实例）。宿主的 `AuthContext` 是它的结构超集，
 * 调用点无需转换。
 *
 * 角色与成员关系不在这里解释：本模块的授权就是「同组织」，跨组织可见性统一由
 * `@fenix/access-control` 产出，包内不复制一套规则。
 */
export interface ProdViewActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * 本服务依赖的外部能力（两项都来自 `@fenix/agent-runtime`）。
 *
 * 以「端口」形式显式声明只用到的最小形状，而不是直接引用 agent-runtime 的记录类型：
 *   - `createWebEnvironment` 返回完整的 environment 行，下游真正读取的只有 `id`（作为实例的宿主环境
 *     标识），在包里复刻一份行结构既随 agent-runtime 的列演进，也没有断言价值；
 *   - 端口同时是测试缝：创建环境会落库并解析 Agent 配置可读性，包内用例没有真实数据库可用，唯一可测
 *     的方式就是在装配点替换它。`findOrCreateDefaultInstance` 原本就以此方式注入。
 * 真实函数是这两个签名的结构超集（参数更宽、返回字段更多），装配处无需适配层。
 */
export interface ProdViewServiceDeps {
  createWebEnvironment(params: {
    name: string;
    description?: string;
    agentConfigId: string;
    autoStart: boolean;
    userId: string;
    organizationId: string;
  }): Promise<{ id: string }>;
  findOrCreateDefaultInstance(environmentId: string, ownerUserId: string): Promise<{ id: string }>;
}

const defaultDeps: ProdViewServiceDeps = {
  // 每次调用现取运行 port（1.4 W3b）：绑定发生在宿主装配阶段，模块求值期取会在装配完成前就抛错。
  createWebEnvironment: (params) => getBoundAgentRuntime().createEnvironment(params),
  findOrCreateDefaultInstance: (environmentId, ownerUserId) =>
    getBoundAgentRuntime().findOrCreateDefaultInstance(environmentId, ownerUserId),
};
const deps: ProdViewServiceDeps = { ...defaultDeps };

/**
 * 测试用：覆盖 ProdView 的外部依赖，避免全局 mock.module 污染其他测试。
 *
 * 替换项只服务包内用例，且必须在 `afterEach` 用 `setProdViewDeps(null)` 复位——替身状态是进程级的，
 * 泄漏到下一条用例的症状是「单独跑通过、全量跑失败」。
 */
export function setProdViewDeps(overrides: Partial<ProdViewServiceDeps> | null): void {
  Object.assign(deps, overrides ?? defaultDeps);
}

/** 创建 ProdView 记录 */
export async function createProdView(actor: ProdViewActor, input: CreateProdViewInput) {
  const row = await prodViewRepo.create({
    organizationId: actor.organizationId,
    name: input.name,
    description: input.description,
    agentId: input.agentId,
    modulesConfig: input.modulesConfig,
    createdBy: actor.userId,
  });
  return { success: true as const, data: row };
}

/** 获取单个 ProdView 详情，不存在时返回 NOT_FOUND 错误 */
export async function getProdView(actor: ProdViewActor, id: string) {
  const row = await prodViewRepo.getById(actor.organizationId, id);
  if (!row) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  return { success: true as const, data: row };
}

/** 列出组织下的 ProdView 列表，可按 agentId 和 enabled 过滤 */
export async function listProdViews(actor: ProdViewActor, filters?: { agentId?: string; enabled?: boolean }) {
  const rows = await prodViewRepo.listByOrg(actor.organizationId, filters);
  return { success: true as const, data: rows };
}

/** 更新 ProdView 配置（名称、描述、模块配置、启用状态），不存在时返回 NOT_FOUND 错误 */
export async function updateProdView(actor: ProdViewActor, id: string, input: UpdateProdViewInput) {
  const existing = await prodViewRepo.getById(actor.organizationId, id);
  if (!existing) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  const row = await prodViewRepo.update(actor.organizationId, id, {
    name: input.name,
    description: input.description,
    modulesConfig: input.modulesConfig,
    enabled: input.enabled,
  });
  return { success: true as const, data: row };
}

/** 删除 ProdView 记录，不存在或被删除失败时返回对应错误 */
export async function deleteProdView(actor: ProdViewActor, id: string) {
  const existing = await prodViewRepo.getById(actor.organizationId, id);
  if (!existing) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  const deleted = await prodViewRepo.delete(actor.organizationId, id);
  if (!deleted) return { success: false as const, error: { code: "DELETE_FAILED", message: "Failed to delete" } };
  return { success: true as const, data: { ok: true } };
}

/** 加载 ProdView 视图数据（公开端点），仅返回 enabled=true 的视图配置 */
export async function loadProdView(actor: ProdViewActor, id: string) {
  const row = await prodViewRepo.getById(actor.organizationId, id);
  if (!row) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  if (!row.enabled) return { success: false as const, error: { code: "DISABLED", message: "ProdView is disabled" } };

  const viewerEnv = await deps.createWebEnvironment({
    name: `env-${row.agentId.slice(0, 8)}`,
    description: row.description ?? undefined,
    agentConfigId: row.agentId,
    autoStart: true,
    userId: actor.userId,
    organizationId: actor.organizationId,
  });
  const instance = await deps.findOrCreateDefaultInstance(viewerEnv.id, actor.userId);

  return {
    success: true as const,
    data: {
      agentConfigId: row.agentId,
      environmentId: viewerEnv.id,
      instanceUid: instance.id,
      name: row.name,
      modulesConfig: row.modulesConfig as Record<string, unknown>,
    },
  };
}
