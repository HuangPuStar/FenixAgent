import { getBoundAgentRuntime } from "@fenix/agent-runtime/runtime";
import type { ProdViewRow } from "@fenix/resource-prod-view/db";
import { prodViewRepo } from "../repositories/prod-view";
import type { CreateProdViewInput, UpdateProdViewInput } from "../schemas/prod-view.schema";

/**
 * 失败信封的 `error.code` 取值：路由据此映射状态码（`NOT_FOUND` / `DISABLED` 都对外表现为 404，
 * 但可观测语义不同，故保留区分）。新增取值前先确认调用方的映射分支。
 */
export type ProdViewErrorCode = "NOT_FOUND" | "DISABLED" | "DELETE_FAILED";

/**
 * 服务层返回信封：成功携带行本体或加载结果，失败携带可区分的错误码。
 *
 * 领域服务不认识 actor——调用的组织范围由调用方（Facade）以显式参数给出，本层只负责资源自身规则
 * 与数据访问，不解释角色、成员关系或 `visibility`。
 */
export type ProdViewResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false; readonly error: { readonly code: ProdViewErrorCode; readonly message: string } };

/** 加载端点的成功载荷：前端据 `environmentId` + `instanceUid` 连接持久实例。 */
export interface ProdViewLoadResult {
  readonly agentConfigId: string;
  readonly environmentId: string;
  readonly instanceUid: string;
  readonly name: string;
  readonly modulesConfig: Record<string, unknown>;
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

/** 创建 ProdView 记录；组织与创建者由调用方（Facade）从 actor 推导后显式传入。 */
export async function createProdView(
  organizationId: string,
  userId: string,
  input: CreateProdViewInput,
): Promise<ProdViewResult<ProdViewRow>> {
  const row = await prodViewRepo.create({
    organizationId,
    name: input.name,
    description: input.description,
    agentId: input.agentId,
    modulesConfig: input.modulesConfig,
    createdBy: userId,
  });
  return { success: true, data: row };
}

/** 获取单个 ProdView 详情，不存在时返回 NOT_FOUND 错误 */
export async function getProdView(organizationId: string, id: string): Promise<ProdViewResult<ProdViewRow>> {
  const row = await prodViewRepo.getById(organizationId, id);
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  return { success: true, data: row };
}

/** 列出组织下的 ProdView 列表，可按 agentId 和 enabled 过滤 */
export async function listProdViews(
  organizationId: string,
  filters?: { agentId?: string; enabled?: boolean },
): Promise<ProdViewResult<ProdViewRow[]>> {
  const rows = await prodViewRepo.listByOrg(organizationId, filters);
  return { success: true, data: rows };
}

/**
 * 更新 ProdView 配置（名称、描述、模块配置、启用状态），不存在时返回 NOT_FOUND 错误。
 *
 * 载荷可能是 `undefined`：先读后写之间记录被并发删除时 UPDATE 不命中，此时沿用迁移前的语义——仍回
 * 成功信封，不把并发窗口升格成对外可见的 404/409（改这个口径属于协议变更，不在本次整改范围）。
 */
export async function updateProdView(
  organizationId: string,
  id: string,
  input: UpdateProdViewInput,
): Promise<ProdViewResult<ProdViewRow | undefined>> {
  const existing = await prodViewRepo.getById(organizationId, id);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  const row = await prodViewRepo.update(organizationId, id, {
    name: input.name,
    description: input.description,
    modulesConfig: input.modulesConfig,
    enabled: input.enabled,
  });
  return { success: true, data: row };
}

/** 删除 ProdView 记录，不存在或被删除失败时返回对应错误 */
export async function deleteProdView(organizationId: string, id: string): Promise<ProdViewResult<{ ok: true }>> {
  const existing = await prodViewRepo.getById(organizationId, id);
  if (!existing) return { success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  const deleted = await prodViewRepo.delete(organizationId, id);
  if (!deleted) return { success: false, error: { code: "DELETE_FAILED", message: "Failed to delete" } };
  return { success: true, data: { ok: true } };
}

/**
 * 加载 ProdView 视图数据（公开读取端点），仅返回 enabled=true 的视图配置。
 *
 * 可见性判定逐条保持：**同组织**（组织谓词来自调用方传入的 `organizationId`）且 `enabled=true`；
 * 记录归属者不影响读取——视图是组织级发布物，任何同组织成员都可加载，停用是唯一的对外下线手段。
 * 环境与持久实例按**访问者本人**（`userId`）创建：视图载体只属于该用户，不与他人共享实例。
 */
export async function loadProdView(
  organizationId: string,
  userId: string,
  id: string,
): Promise<ProdViewResult<ProdViewLoadResult>> {
  const row = await prodViewRepo.getById(organizationId, id);
  if (!row) return { success: false, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  if (!row.enabled) return { success: false, error: { code: "DISABLED", message: "ProdView is disabled" } };

  const viewerEnv = await deps.createWebEnvironment({
    name: `env-${row.agentId.slice(0, 8)}`,
    description: row.description ?? undefined,
    agentConfigId: row.agentId,
    autoStart: true,
    userId,
    organizationId,
  });
  const instance = await deps.findOrCreateDefaultInstance(viewerEnv.id, userId);

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
