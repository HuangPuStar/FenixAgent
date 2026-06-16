import { log } from "@fenix/logger";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, machine, registryEvent } from "../db/schema";
import type { AuthContext } from "../plugins/auth";

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 22)}`;
}

export async function listMachines(
  ctx: AuthContext,
  filters: { status?: "online" | "offline"; labels?: string[]; limit?: number; offset?: number },
): Promise<{ data: (typeof machine.$inferSelect)[]; total: number }> {
  const conditions = [
    or(isNull(machine.organizationId), eq(machine.organizationId, ctx.organizationId)),
    or(isNull(machine.userId), eq(machine.userId, ctx.userId)),
  ];

  if (filters.status) {
    conditions.push(eq(machine.status, filters.status));
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

  const rows = await db
    .select()
    .from(machine)
    .where(where)
    .orderBy(desc(machine.registeredAt))
    .limit(limit)
    .offset(offset);

  const countRows = await db.select({ count: sql<number>`count(*)` }).from(machine).where(where);

  return { data: rows, total: countRows[0].count };
}

export async function getMachine(
  ctx: AuthContext,
  id: string,
): Promise<(typeof machine.$inferSelect & { recentEvents: (typeof registryEvent.$inferSelect)[] }) | null> {
  const rows = await db
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

  const events = await db
    .select()
    .from(registryEvent)
    .where(eq(registryEvent.machineId, id))
    .orderBy(desc(registryEvent.createdAt))
    .limit(10);

  return { ...record, recentEvents: events };
}

export async function listEvents(
  ctx: AuthContext,
  machineId: string,
  opts: { limit: number; offset: number },
): Promise<{ data: (typeof registryEvent.$inferSelect)[]; total: number }> {
  const machineRows = await db
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

  const rows = await db
    .select()
    .from(registryEvent)
    .where(eq(registryEvent.machineId, machineId))
    .orderBy(desc(registryEvent.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);

  const countRows = await db
    .select({ count: sql<number>`count(*)` })
    .from(registryEvent)
    .where(eq(registryEvent.machineId, machineId));

  return { data: rows, total: countRows[0].count };
}

export async function registerMachine(params: {
  name: string | null;
  agentName: string;
  machineInfo: Record<string, unknown> | null;
  labels: string[];
  heartbeatIntervalMs: number;
  tenantId: string | null;
  userId: string | null;
  /** 客户端持久化的 node_id，用于精确去重（避免 IP/MAC 变化导致重复注册） */
  nodeId?: string | null;
  supportedEngineTypes?: { type: string; cliPath?: string }[];
}): Promise<{ id: string; isNew: boolean }> {
  const hostname = params.machineInfo?.hostname as string | undefined;
  let existingId: string | null = null;

  // ── 去重策略 ──
  // 优先级 1：按客户端持久化的 node_id 精确匹配（最可靠，跨 IP/MAC 变化稳定）
  if (params.nodeId) {
    const byNodeId = await db.select({ id: machine.id }).from(machine).where(eq(machine.id, params.nodeId)).limit(1);
    existingId = byNodeId[0]?.id ?? null;
  }

  // 优先级 2：fallback 按 hostname + agentName 查找（兼容旧客户端或 node_id 丢失）
  if (!existingId && hostname) {
    const byHostname = await db
      .select({ id: machine.id })
      .from(machine)
      .where(and(eq(machine.agentName, params.agentName), sql`${machine.machineInfo}->>'hostname' = ${hostname}`))
      .limit(1);
    existingId = byHostname[0]?.id ?? null;
  }

  const now = new Date();

  // ── 已存在的机器重连：更新状态，写 reconnect 事件 ──
  if (existingId) {
    await db
      .update(machine)
      .set({
        status: "online",
        machineInfo: params.machineInfo,
        labels: params.labels,
        supportedEngineTypes: params.supportedEngineTypes,
        name: params.name,
        heartbeatIntervalMs: params.heartbeatIntervalMs,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(machine.id, existingId));

    // 重连事件与首次注册区分，避免 registry_event 表堆积无意义的重复 register 记录
    await db.insert(registryEvent).values({
      id: genId("evt"),
      machineId: existingId,
      type: "reconnect",
      detail: { machine_info: params.machineInfo, labels: params.labels },
    });

    await bindAgentConfigs(existingId, params.agentName, params.tenantId);
    return { id: existingId, isNew: false };
  }

  // ── 新机器首次注册：生成随机 ID，写 register 事件 ──
  const id = genId("mach");
  await db.insert(machine).values({
    id,
    organizationId: params.tenantId ?? null,
    userId: params.userId ?? null,
    agentName: params.agentName,
    name: params.name,
    status: "online",
    machineInfo: params.machineInfo,
    labels: params.labels,
    supportedEngineTypes: params.supportedEngineTypes,
    heartbeatIntervalMs: params.heartbeatIntervalMs,
    lastHeartbeatAt: now,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  await db.insert(registryEvent).values({
    id: genId("evt"),
    machineId: id,
    type: "register",
    detail: { machine_info: params.machineInfo, labels: params.labels },
  });

  await bindAgentConfigs(id, params.agentName, params.tenantId);
  return { id, isNew: true };
}

export async function disconnectMachine(machineId: string, reason: string): Promise<void> {
  await db.update(machine).set({ status: "offline", updatedAt: new Date() }).where(eq(machine.id, machineId));

  await db.insert(registryEvent).values({
    id: genId("evt"),
    machineId,
    type: "disconnect",
    detail: { reason },
  });
}

export async function markHeartbeatTimeout(machineId: string): Promise<void> {
  await db.update(machine).set({ status: "offline", updatedAt: new Date() }).where(eq(machine.id, machineId));

  await db.insert(registryEvent).values({
    id: genId("evt"),
    machineId,
    type: "heartbeat_timeout",
    detail: { reason: "heartbeat timeout" },
  });
}

export async function updateHeartbeat(machineId: string): Promise<void> {
  await db.update(machine).set({ lastHeartbeatAt: new Date(), updatedAt: new Date() }).where(eq(machine.id, machineId));
}

/** 按 agentName 匹配 agentConfig 并绑定 machineId */
async function bindAgentConfigs(machineId: string, agentName: string, tenantId: string | null): Promise<void> {
  if (!tenantId) return;
  const conditions = [eq(agentConfig.organizationId, tenantId), eq(agentConfig.name, agentName)];
  await db
    .update(agentConfig)
    .set({ machineId, updatedAt: new Date() })
    .where(and(...conditions));
}

/** 服务启动时调用：将所有 online 状态的 machine 重置为 offline（服务重启后 WS 连接均已断开） */
export async function resetAllMachinesOffline(): Promise<void> {
  const result = await db
    .update(machine)
    .set({ status: "offline", updatedAt: new Date() })
    .where(eq(machine.status, "online"));
  // biome-ignore lint/suspicious/noExplicitAny: Drizzle RowList doesn't expose rowCount in type
  const count = (result as any).rowCount;
  if (count > 0) {
    log(`[registry] Reset ${count} machines to offline after restart`);
  }
}
