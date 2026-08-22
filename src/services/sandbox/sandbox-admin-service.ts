import type { SandboxInstance, SandboxPool } from "../../db/schema";
import { findMachinesBasicInfoByIds } from "../../repositories/machine-repository";
import { organizationRepo } from "../../repositories/organization";
import { findSandboxInstanceById, listSandboxInstances } from "../../repositories/sandbox-instance-repository";
import {
  createSandboxPool,
  deleteSandboxPool,
  findSandboxPoolById,
  listReadableSandboxPools,
  listSandboxPools,
  updateSandboxPool,
} from "../../repositories/sandbox-pool-repository";
import { findUsersBasicInfoByIds } from "../../repositories/user";
import type {
  SandboxInstanceRebuildBody,
  SandboxPoolCreateBody,
  SandboxPoolUpdateBody,
} from "../../schemas/api-sandbox.schema";
import { sandboxManager } from "./index";

function date(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function poolResponse(pool: SandboxPool, organizationName?: string | null) {
  return {
    ...pool,
    organizationName: pool.organizationId ? (organizationName ?? null) : null,
    createdAt: pool.createdAt.toISOString(),
    updatedAt: pool.updatedAt.toISOString(),
  };
}

function instanceResponse(
  instance: SandboxInstance,
  owner?: { id: string; name: string; email: string } | null,
  machine?: {
    id: string;
    name: string | null;
    agentName: string;
    status: string;
    lastHeartbeatAt: Date | null;
  } | null,
) {
  return {
    ...instance,
    user: owner ?? { id: instance.userId, name: instance.userId, email: "" },
    machine: machine
      ? {
          id: machine.id,
          name: machine.name ?? machine.agentName,
          status: machine.status,
          lastHeartbeatAt: date(machine.lastHeartbeatAt),
        }
      : { id: instance.machineId, name: instance.machineId, status: "unknown", lastHeartbeatAt: null },
    lastHeartbeatAt: date(instance.lastHeartbeatAt),
    createdAt: instance.createdAt.toISOString(),
    updatedAt: instance.updatedAt.toISOString(),
  };
}

export async function listPools(filters: { organization_id?: string; provider_key?: string }) {
  const pools = (await listSandboxPools())
    .filter(
      (pool) =>
        !filters.organization_id || pool.organizationId === null || pool.organizationId === filters.organization_id,
    )
    .filter((pool) => !filters.provider_key || pool.providerKey === filters.provider_key);
  const names = await organizationRepo.listNamesByIds(
    pools.flatMap((pool) => (pool.organizationId ? [pool.organizationId] : [])),
  );
  return pools.map((pool) => poolResponse(pool, pool.organizationId ? names.get(pool.organizationId) : null));
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
  const existing = await findSandboxPoolById(input.id);
  if (existing) throw new Error(`sandbox pool '${input.id}' already exists`);

  const pool = await createSandboxPool({
    ...input,
    organizationId: input.organizationId ?? null,
    extra: input.extra ?? null,
  });
  const names = pool.organizationId ? await organizationRepo.listNamesByIds([pool.organizationId]) : new Map();
  return poolResponse(pool, pool.organizationId ? names.get(pool.organizationId) : null);
}

export async function getPool(id: string) {
  const pool = await findSandboxPoolById(id);
  if (!pool) throw new Error(`sandbox pool '${id}' not found`);
  const names = pool.organizationId ? await organizationRepo.listNamesByIds([pool.organizationId]) : new Map();
  return poolResponse(pool, pool.organizationId ? names.get(pool.organizationId) : null);
}

export async function updatePool(id: string, input: SandboxPoolUpdateBody) {
  const pool = await updateSandboxPool(id, {
    ...input,
    organizationId: input.organizationId ?? null,
    extra: input.extra ?? null,
  });
  if (!pool) throw new Error(`sandbox pool '${id}' not found`);
  const names = pool.organizationId ? await organizationRepo.listNamesByIds([pool.organizationId]) : new Map();
  return poolResponse(pool, pool.organizationId ? names.get(pool.organizationId) : null);
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
  const [owners, machines] = await Promise.all([
    findUsersBasicInfoByIds([...new Set(rows.map((row) => row.userId))]),
    findMachinesBasicInfoByIds([...new Set(rows.map((row) => row.machineId))]),
  ]);
  const ownerMap = new Map(owners.map((owner) => [owner.id, owner]));
  const machineMap = new Map(machines.map((item) => [item.id, item]));
  const start = (filters.page - 1) * filters.page_size;
  return {
    items: rows
      .slice(start, start + filters.page_size)
      .map((instance) => instanceResponse(instance, ownerMap.get(instance.userId), machineMap.get(instance.machineId))),
    total: rows.length,
    page: filters.page,
    pageSize: filters.page_size,
  };
}

export async function getInstance(id: string) {
  const instance = await findSandboxInstanceById(id);
  if (!instance) throw new Error(`sandbox instance '${id}' not found`);
  const [owners, machines] = await Promise.all([
    findUsersBasicInfoByIds([instance.userId]),
    findMachinesBasicInfoByIds([instance.machineId]),
  ]);
  return instanceResponse(instance, owners[0], machines[0]);
}

export async function updateInstance(
  id: string,
  resourceOverrides: {
    cpu?: number | null;
    memoryMb?: number | null;
    diskGb?: number | null;
    gpuCount?: number | null;
  } | null,
) {
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
