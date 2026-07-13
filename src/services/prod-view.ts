import type { AuthContext } from "../plugins/auth";
import { prodViewRepo } from "../repositories/prod-view";
import type { CreateProdViewInput, UpdateProdViewInput } from "../schemas/prod-view.schema";

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

export async function getProdView(ctx: AuthContext, id: string) {
  const row = await prodViewRepo.getById(ctx.organizationId, id);
  if (!row) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  return { success: true as const, data: row };
}

export async function listProdViews(ctx: AuthContext, filters?: { agentId?: string; enabled?: boolean }) {
  const rows = await prodViewRepo.listByOrg(ctx.organizationId, filters);
  return { success: true as const, data: rows };
}

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

export async function deleteProdView(ctx: AuthContext, id: string) {
  const existing = await prodViewRepo.getById(ctx.organizationId, id);
  if (!existing) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  const deleted = await prodViewRepo.delete(ctx.organizationId, id);
  if (!deleted) return { success: false as const, error: { code: "DELETE_FAILED", message: "Failed to delete" } };
  return { success: true as const, data: { ok: true } };
}

export async function loadProdView(ctx: AuthContext, id: string) {
  const row = await prodViewRepo.getById(ctx.organizationId, id);
  if (!row) return { success: false as const, error: { code: "NOT_FOUND", message: "ProdView not found" } };
  if (!row.enabled) return { success: false as const, error: { code: "DISABLED", message: "ProdView is disabled" } };
  return {
    success: true as const,
    data: { agentId: row.agentId, name: row.name, modulesConfig: row.modulesConfig as Record<string, unknown> },
  };
}
