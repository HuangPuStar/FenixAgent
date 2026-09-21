import { log } from "@fenix/logger";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { machine, registryEvent } from "@fenix/resource-machine/db";
import { agentConfig } from "@server/db/schema";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { getMachineDatabase } from "../db";
import { getMachineLifecyclePort } from "../machine-lifecycle-port";
import { writeRegistryEvent } from "../repositories/registry-event";
import { closeMachineFileWsConnection } from "../transport/file-ws-handler";
import type { MachineRequestAuth } from "../types/auth";

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 22)}`;
}

function buildMachineOwnershipConditions(ctx: MachineRequestAuth) {
  return [
    eq(machine.organizationId, ctx.organizationId),
    or(isNull(machine.userId), eq(machine.userId, ctx.userId)),
  ] as const;
}

export async function listMachines(
  ctx: MachineRequestAuth,
  filters: {
    status?: "online" | "offline";
    type?: "machine" | "sandbox" | "all";
    labels?: string[];
    limit?: number;
    offset?: number;
  },
): Promise<{ data: (typeof machine.$inferSelect)[]; total: number }> {
  const conditions = [
    or(isNull(machine.organizationId), eq(machine.organizationId, ctx.organizationId)),
    or(isNull(machine.userId), eq(machine.userId, ctx.userId)),
  ];

  if (filters.status) {
    conditions.push(eq(machine.status, filters.status));
  }

  if (filters.type !== "all") {
    conditions.push(eq(machine.type, filters.type ?? "machine"));
  }

  if (filters.labels && filters.labels.length > 0) {
    conditions.push(
      sql`${machine.labels} ?| array[${sql.join(
        filters.labels.map((l) => sql`${l}`),
        sql`, `,
      )}]`,
    );
  }

  const where = and(...conditions);
  const limit = filters.limit ?? 20;
  const offset = filters.offset ?? 0;

  const rows = await getMachineDatabase()
    .select()
    .from(machine)
    .where(where)
    .orderBy(desc(machine.registeredAt))
    .limit(limit)
    .offset(offset);

  const countRows = await getMachineDatabase().select({ count: sql<number>`count(*)` }).from(machine).where(where);

  return { data: rows, total: countRows[0].count };
}

export async function getMachine(
  ctx: MachineRequestAuth,
  id: string,
): Promise<(typeof machine.$inferSelect & { recentEvents: (typeof registryEvent.$inferSelect)[] }) | null> {
  const rows = await getMachineDatabase()
    .select()
    .from(machine)
    .where(
      and(
        eq(machine.id, id),
        or(isNull(machine.organizationId), eq(machine.organizationId, ctx.organizationId)),
        or(isNull(machine.userId), eq(machine.userId, ctx.userId)),
      ),
    )
    .limit(1);

  const record = rows[0];
  if (!record) return null;

  const events = await getMachineDatabase()
    .select()
    .from(registryEvent)
    .where(eq(registryEvent.machineId, id))
    .orderBy(desc(registryEvent.createdAt))
    .limit(10);

  return { ...record, recentEvents: events };
}

export async function listEvents(
  ctx: MachineRequestAuth,
  machineId: string,
  opts: { limit: number; offset: number },
): Promise<{ data: (typeof registryEvent.$inferSelect)[]; total: number }> {
  const machineRows = await getMachineDatabase()
    .select()
    .from(machine)
    .where(
      and(
        eq(machine.id, machineId),
        or(isNull(machine.organizationId), eq(machine.organizationId, ctx.organizationId)),
        or(isNull(machine.userId), eq(machine.userId, ctx.userId)),
      ),
    )
    .limit(1);

  if (machineRows.length === 0) {
    return { data: [], total: 0 };
  }

  const rows = await getMachineDatabase()
    .select()
    .from(registryEvent)
    .where(eq(registryEvent.machineId, machineId))
    .orderBy(desc(registryEvent.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);

  const countRows = await getMachineDatabase()
    .select({ count: sql<number>`count(*)` })
    .from(registryEvent)
    .where(eq(registryEvent.machineId, machineId));

  return { data: rows, total: countRows[0].count };
}

/**
 * 管理员预创建机器记录（status=pending）。
 * 返回 machine id 和包含 RCS_MACHINE_ID + RCS_SECRET 的初始化命令。
 */
export async function createMachine(
  ctx: MachineRequestAuth,
  params: { name: string; labels?: string[]; agentName?: string },
): Promise<{ id: string; name: string; status: "pending"; initCommand: string }> {
  const id = genId("mach");
  const now = new Date();
  const agentName = params.agentName ?? "opencode";
  const labels = params.labels ?? [];

  await getMachineDatabase().insert(machine).values({
    id,
    organizationId: ctx.organizationId,
    userId: null,
    agentName,
    name: params.name,
    type: "machine",
    status: "pending",
    machineInfo: null,
    labels,
    heartbeatIntervalMs: 30000,
    lastHeartbeatAt: null,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const initCommand = [
    `RCS_MACHINE_ID=${id}`,
    `RCS_SECRET=<your-registry-secret>`,
    `AGENT_TYPE=${agentName}`,
    `acp-runtime ${agentName} acp`,
  ].join(" ");

  return { id, name: params.name, status: "pending", initCommand };
}

/**
 * 为 Sandbox Instance 预创建一条系统托管的 Machine 身份。
 *
 * Sandbox 连接仍然使用现有 Machine 注册协议，因此 Provider 创建前必须先确定稳定的
 * machine_id；此方法只写入注册元数据，不建立连接，也不生成 Provider 配置。
 */
export async function createSandboxMachine(params: {
  id: string;
  organizationId: string | null;
  userId: string;
  agentName: string;
}): Promise<void> {
  const now = new Date();

  await getMachineDatabase().insert(machine).values({
    id: params.id,
    organizationId: params.organizationId,
    userId: params.userId,
    agentName: params.agentName,
    name: params.id,
    type: "sandbox",
    status: "pending",
    machineInfo: null,
    labels: [],
    heartbeatIntervalMs: 30000,
    lastHeartbeatAt: null,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

/**
 * 补齐部署兜底机器记录（幂等）。
 *
 * `RCS_DEFAULT_MACHINE_ID` 指向的机器随部署自带、注册前不存在，因此启动时需要一条 pending 记录作为
 * 后续 acp-ws 注册的锚点：`organizationId` / `userId` 均为 null，表示系统机器、对所有组织可见。
 *
 * 为什么归本包：`machine` 表是本包的数据面，此前宿主在自己的启动引导里直接 select / insert 该表，属
 * 「表与它的写入分处两层」。宿主仍负责读环境（兜底机器 ID 与引擎类型来自 `RCS_*`），本函数只接收已解析的
 * 值——包内不读环境变量，默认引擎类型的兜底与部署值来源同源。
 *
 * @returns 本次是否新建；已存在时返回 false，且不覆盖既有注册信息（status / machineInfo / 心跳字段）
 */
export async function ensureDefaultMachine(params: { machineId: string; agentName: string }): Promise<boolean> {
  const existing = await getMachineDatabase()
    .select({ id: machine.id })
    .from(machine)
    .where(eq(machine.id, params.machineId))
    .limit(1);

  if (existing.length > 0) return false;

  const now = new Date();

  await getMachineDatabase().insert(machine).values({
    id: params.machineId,
    organizationId: null,
    userId: null,
    agentName: params.agentName,
    name: "system-default",
    status: "pending",
    machineInfo: null,
    labels: [],
    heartbeatIntervalMs: 30000,
    lastHeartbeatAt: null,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  log(`[registry] Auto-created default machine ${params.machineId} (status=pending)`);

  return true;
}

/**
 * 删除 sandbox machine 记录。
 *
 * 与 deleteMachine（管理面删除，含引用校验与 file-ws 清理）语义不同：此处只
 * 用于 sandbox 生命周期的补偿清理，机器通常尚未注册运行，仅需删除记录。
 */
export async function deleteSandboxMachine(id: string): Promise<void> {
  await getMachineDatabase().delete(machine).where(eq(machine.id, id));
}

/**
 * Machine 注册连接处理器。
 *
 * 仅负责运行时状态激活/重连（status、lastHeartbeatAt、updatedAt），
 * **不写入任何元数据字段**（name、labels、machineInfo 等）。
 * machine 必须在管理面通过 `POST /web/registry/machines` 预创建后才能连接，
 * 未预创建的连接将被拒绝（不再支持自动注册）。
 *
 * @param params.machineId - 客户端指定的 machine ID，对应管理面预创建记录
 * @param params.agentName - 引擎名称，用于 bindAgentConfigs 自动匹配
 * @param params.tenantId - 组织 ID，用于 bindAgentConfigs 范围限定
 */
export async function registerMachine(params: {
  agentName: string;
  tenantId: string | null;
  machineId: string;
}): Promise<{ id: string; isNew: boolean }> {
  const existing = await getMachineDatabase()
    .select({ id: machine.id, status: machine.status })
    .from(machine)
    .where(eq(machine.id, params.machineId))
    .limit(1);

  // machine 不存在：必须在组织管理界面先创建
  if (existing.length === 0) {
    throw new Error(`machine '${params.machineId}' not found, please create it first in your organization`);
  }

  const now = new Date();

  // server 重启后 DB 状态可能过期，允许重连
  if (existing[0].status === "online") {
    log(`[registry] machine id '${params.machineId}' was already online (stale), allowing reconnection`);
  }

  const isFirstRegistration = existing[0].status === "pending";
  const eventType = isFirstRegistration ? "register" : "reconnect";

  // pending 或 offline → 激活为 online
  await getMachineDatabase()
    .update(machine)
    .set({
      status: "online",
      lastHeartbeatAt: now,
      updatedAt: now,
    })
    .where(eq(machine.id, params.machineId));

  await getMachineDatabase()
    .insert(registryEvent)
    .values({
      id: genId("evt"),
      machineId: params.machineId,
      type: eventType,
      detail: {},
    });

  await getMachineLifecyclePort()?.notifyMachineRegistered(params.machineId, now);
  await bindAgentConfigs(params.machineId, params.agentName, params.tenantId);
  return { id: params.machineId, isNew: isFirstRegistration };
}

export async function disconnectMachine(machineId: string, reason: string): Promise<void> {
  await getMachineDatabase()
    .update(machine)
    .set({ status: "offline", updatedAt: new Date() })
    .where(eq(machine.id, machineId));

  await getMachineDatabase()
    .insert(registryEvent)
    .values({
      id: genId("evt"),
      machineId,
      type: "disconnect",
      detail: { reason },
    });
}

export async function markHeartbeatTimeout(machineId: string): Promise<void> {
  await getMachineDatabase()
    .update(machine)
    .set({ status: "offline", updatedAt: new Date() })
    .where(eq(machine.id, machineId));

  await getMachineDatabase()
    .insert(registryEvent)
    .values({
      id: genId("evt"),
      machineId,
      type: "heartbeat_timeout",
      detail: { reason: "heartbeat timeout" },
    });
}

export async function updateHeartbeat(machineId: string): Promise<void> {
  await getMachineDatabase()
    .update(machine)
    .set({ lastHeartbeatAt: new Date(), updatedAt: new Date() })
    .where(eq(machine.id, machineId));
}

/**
 * 由管理面调用，更新机器的名称、标签和引擎类型。
 * 仅允许组织管理员操作，校验组织归属。
 */
export async function updateMachine(
  ctx: MachineRequestAuth,
  id: string,
  params: { name?: string; labels?: string[]; agentName?: string },
): Promise<typeof machine.$inferSelect> {
  const ownershipConditions = buildMachineOwnershipConditions(ctx);
  const rows = await getMachineDatabase()
    .select()
    .from(machine)
    .where(and(eq(machine.id, id), ...ownershipConditions))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`machine '${id}' not found`);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.name !== undefined) updates.name = params.name;
  if (params.labels !== undefined) updates.labels = params.labels;
  if (params.agentName !== undefined) updates.agentName = params.agentName;

  await getMachineDatabase()
    .update(machine)
    .set(updates)
    .where(and(eq(machine.id, id), ...ownershipConditions));

  const updated = await getMachineDatabase()
    .select()
    .from(machine)
    .where(and(eq(machine.id, id), ...ownershipConditions))
    .limit(1);
  return updated[0];
}

/**
 * 删除机器前执行安全校验：
 * 1. 在线机器不可删除，避免删除后仍保留活跃连接。
 * 2. 被 Agent 配置或组织默认引擎引用的机器不可删除，避免产生悬空 machineId。
 */
export async function deleteMachine(ctx: MachineRequestAuth, id: string): Promise<{ deleted: true }> {
  const ownershipConditions = buildMachineOwnershipConditions(ctx);
  const rows = await getMachineDatabase()
    .select()
    .from(machine)
    .where(and(eq(machine.id, id), ...ownershipConditions))
    .limit(1);

  const record = rows[0];
  if (!record) {
    throw new Error(`machine '${id}' not found`);
  }

  if (record.status === "online") {
    throw new Error(`machine '${id}' is online and cannot be deleted`);
  }

  const referencedAgents = await getMachineDatabase()
    .select()
    .from(agentConfig)
    .where(and(eq(agentConfig.organizationId, ctx.organizationId), eq(agentConfig.machineId, id)))
    .limit(1);
  if (referencedAgents.length > 0) {
    throw new Error(`machine '${id}' is still referenced by agent configs`);
  }

  // 组织默认引擎引用经目录读取：`organization` 表的 owner 是身份模块，本包不得直查该表。
  const organization = await getIdentityDirectory().getOrganization(ctx.organizationId);
  if (organization?.defaultMachineId === id) {
    throw new Error(`machine '${id}' is still referenced by organization default engine`);
  }

  await getMachineDatabase()
    .delete(machine)
    .where(and(eq(machine.id, id), ...ownershipConditions));

  // P0-5（D18）：DB 删除后立即切断退役机器的 file-ws 连接（reject pending + 清索引 + close），
  // 避免机器已删除但 machineFileWsIndex 残留导致 isFileWsConnected 恒真、请求悬挂；
  // 并写 retired 事件归档。两者为尽力而为的后置清理：失败只记录日志，不阻断删除结果——
  // 机器记录此时已删除，若返回错误会造成"实际已删但界面报错"的不一致。
  try {
    closeMachineFileWsConnection(id);
  } catch (err) {
    log(`[registry] file-ws cleanup failed for machine '${id}': ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    await writeRegistryEvent(id, "retired", { reason: "machine deleted" });
  } catch (err) {
    log(
      `[registry] retired event write failed for machine '${id}': ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { deleted: true };
}

/** 按 agentName 匹配 agentConfig 并绑定 machineId */
async function bindAgentConfigs(machineId: string, agentName: string, tenantId: string | null): Promise<void> {
  if (!tenantId) return;
  const conditions = [eq(agentConfig.organizationId, tenantId), eq(agentConfig.name, agentName)];
  await getMachineDatabase()
    .update(agentConfig)
    .set({ machineId, updatedAt: new Date() })
    .where(and(...conditions));
}

/** 服务启动时调用：将所有 online 状态的 machine 重置为 offline（服务重启后 WS 连接均已断开） */
export async function resetAllMachinesOffline(): Promise<void> {
  const result = await getMachineDatabase()
    .update(machine)
    .set({ status: "offline", updatedAt: new Date() })
    .where(eq(machine.status, "online"));
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle RowList doesn't expose rowCount in type
  const count = (result as any).rowCount;
  if (count > 0) {
    log(`[registry] Reset ${count} machines to offline after restart`);
  }
}
