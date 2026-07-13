import type { AuthContext } from "../plugins/auth";
import { environmentRepo } from "../repositories/environment";
import { prodViewRepo } from "../repositories/prod-view";
import type { CreateProdViewInput, UpdateProdViewInput } from "../schemas/prod-view.schema";

/** 创建 ProdView 记录 */
export async function createProdView(ctx: AuthContext, input: CreateProdViewInput) {
  const row = await prodViewRepo.create({
    organizationId: ctx.organizationId,
    name: input.name,
    description: input.description,
    agentId: input.agentId,
    createdBy: ctx.userId,
  });
  return { success: true as const, data: row };
}

/** 获取单个 ProdView 详情，不存在时返回 NOT_FOUND 错误 */
export async function getProdView(ctx: AuthContext, id: string) {
  const row = await prodViewRepo.getById(ctx.organizationId, id);
  if (!row) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  return { success: true as const, data: row };
}

/** 列出组织下的 ProdView 列表，可按 agentId 和 enabled 过滤 */
export async function listProdViews(ctx: AuthContext, filters?: { agentId?: string; enabled?: boolean }) {
  const rows = await prodViewRepo.listByOrg(ctx.organizationId, filters);
  return { success: true as const, data: rows };
}

/** 更新 ProdView 配置（名称、描述、模块配置、启用状态），不存在时返回 NOT_FOUND 错误 */
export async function updateProdView(ctx: AuthContext, id: string, input: UpdateProdViewInput) {
  const existing = await prodViewRepo.getById(ctx.organizationId, id);
  if (!existing) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  const row = await prodViewRepo.update(ctx.organizationId, id, {
    name: input.name,
    description: input.description,
    modulesConfig: input.modulesConfig,
    enabled: input.enabled,
  });
  return { success: true as const, data: row };
}

/** 删除 ProdView 记录，不存在或被删除失败时返回对应错误 */
export async function deleteProdView(ctx: AuthContext, id: string) {
  const existing = await prodViewRepo.getById(ctx.organizationId, id);
  if (!existing) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  const deleted = await prodViewRepo.delete(ctx.organizationId, id);
  if (!deleted) return { success: false as const, error: { code: "DELETE_FAILED", message: "Failed to delete" } };
  return { success: true as const, data: { ok: true } };
}

/** 加载 ProdView 视图数据（公开端点），仅返回 enabled=true 的视图配置 */
export async function loadProdView(ctx: AuthContext, id: string) {
  const row = await prodViewRepo.getById(ctx.organizationId, id);
  if (!row) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  if (!row.enabled) return { success: false as const, error: { code: "DISABLED", message: "ProdView is disabled" } };

  // 解析 agentConfigId → environmentId（relay 连接需要 env_xxx 格式）
  let environmentId: string | null = null;
  if (row.agentId) {
    const env = await environmentRepo.findByAgentConfigId(ctx.organizationId, row.agentId);
    environmentId = env?.id ?? null;
  }

  return {
    success: true as const,
    data: {
      agentConfigId: row.agentId,
      environmentId,
      name: row.name,
      modulesConfig: row.modulesConfig as Record<string, unknown>,
    },
  };
}
