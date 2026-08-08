import type { SandboxResourceOverrides } from "@fenix/sandbox-provider";
import type { SandboxInstance, SandboxPool } from "../../db/schema";
import { findSandboxInstanceById, listSandboxInstances } from "../../repositories/sandbox-instance-repository";
import {
  createSandboxPool,
  deleteSandboxPool,
  findSandboxPoolById,
  listReadableSandboxPools,
  listSandboxPools,
  updateSandboxPool,
} from "../../repositories/sandbox-pool-repository";
import type {
  SandboxInstanceRebuildBody,
  SandboxPoolCreateBody,
  SandboxPoolUpdateBody,
} from "../../schemas/api-sandbox.schema";
import { sandboxManager } from "./index";

function date(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function poolResponse(pool: SandboxPool) {
  return { ...pool, createdAt: pool.createdAt.toISOString(), updatedAt: pool.updatedAt.toISOString() };
}

function instanceResponse(instance: SandboxInstance) {
  return {
    ...instance,
    lastHeartbeatAt: date(instance.lastHeartbeatAt),
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

export async function listPools(filters: { organization_id?: string; provider_key?: string }) {
  return (await listSandboxPools())
    .filter(
      (pool) =>
        !filters.organization_id || pool.organizationId === null || pool.organizationId === filters.organization_id,
    )
    .filter((pool) => !filters.provider_key || pool.providerKey === filters.provider_key)
    .map(poolResponse);
}

/** 返回 Agent 配置页面可选择的沙盒资源池，不暴露资源和 Provider 专属配置。 */
export async function listPoolOptions(
  organizationId: string,
  sandboxEnabled: boolean,
  repository: (organizationId: string) => Promise<SandboxPool[]> = listReadableSandboxPools,
) {
  if (!sandboxEnabled) return { enabled: false as const, pools: [] };
  const pools = await repository(organizationId);
  return {
    enabled: true as const,
    pools: pools.map((pool) => ({ id: pool.id, name: pool.name })),
  };
}

export async function createPool(input: SandboxPoolCreateBody) {
  return poolResponse(
    await createSandboxPool({
      ...input,
      organizationId: input.organizationId ?? null,
      extra: input.extra ?? null,
    }),
  );
}

export async function getPool(id: string) {
  const pool = await findSandboxPoolById(id);
  if (!pool) throw new Error(`sandbox pool '${id}' not found`);
  return poolResponse(pool);
}

export async function updatePool(id: string, input: SandboxPoolUpdateBody) {
  const pool = await updateSandboxPool(id, {
    ...input,
    organizationId: input.organizationId ?? null,
    extra: input.extra ?? null,
  });
  if (!pool) throw new Error(`sandbox pool '${id}' not found`);
  return poolResponse(pool);
}

export async function deletePool(id: string) {
  const instances = await listSandboxInstances({ sandboxPoolId: id });
  if (instances.length > 0) throw new Error(`sandbox pool '${id}' has existing sandbox instances`);
  const pool = await deleteSandboxPool(id);
  if (!pool) throw new Error(`sandbox pool '${id}' not found`);
  return { deleted: true as const };
}

export async function listInstances(filters: {
  user_id?: string;
  sandbox_pool_id?: string;
  provider_key?: string;
  status?: string;
  page: number;
  page_size: number;
}) {
  const rows = await listSandboxInstances({
    userIds: filters.user_id ? [filters.user_id] : undefined,
    sandboxPoolId: filters.sandbox_pool_id,
    providerKey: filters.provider_key,
    statuses: filters.status ? [filters.status] : undefined,
  });
  const start = (filters.page - 1) * filters.page_size;
  return {
    items: rows.slice(start, start + filters.page_size).map(instanceResponse),
    total: rows.length,
    page: filters.page,
    pageSize: filters.page_size,
  };
}

export async function getInstance(id: string) {
  const instance = await findSandboxInstanceById(id);
  if (!instance) throw new Error(`sandbox instance '${id}' not found`);
  return instanceResponse(instance);
}

export async function updateInstance(id: string, resourceOverrides: SandboxResourceOverrides | null) {
  return instanceResponse(await sandboxManager.updateInstanceConfig(id, resourceOverrides));
}

export async function deleteInstance(id: string) {
  const instance = await findSandboxInstanceById(id);
  if (!instance) return { deleted: true as const };
  await sandboxManager.deleteForUser(id, instance.userId);
  return { deleted: true as const };
}

export function rebuildInstances(input: SandboxInstanceRebuildBody) {
  return sandboxManager.rebuildInstances(input);
}
