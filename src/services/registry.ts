import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { machine, registryEvent } from "../db/schema";
import { log } from "../logger";
import type { AuthContext } from "../plugins/auth";

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 22)}`;
}

function deriveMachineId(machineInfo: Record<string, unknown> | null): string {
  const ip = (machineInfo?.ip as string) ?? "0.0.0.0";
  const mac = (machineInfo?.mac as string) ?? "";
  const os = (machineInfo?.os as string) ?? "unknown";
  return `mach_${ip}_${os}_${mac}`;
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
  agentName: string;
  machineInfo: Record<string, unknown> | null;
  labels: string[];
  heartbeatIntervalMs: number;
  tenantId: string | null;
  userId: string | null;
}): Promise<{ id: string }> {
  const hostname = params.machineInfo?.hostname as string | undefined;
  const id = deriveMachineId(params.machineInfo);
  let existingId: string | null = null;

  // dedup by derived ID (ip+os+mac → same ID)
  const existing = await db.select({ id: machine.id }).from(machine).where(eq(machine.id, id)).limit(1);
  existingId = existing[0]?.id ?? null;

  if (!existingId && hostname) {
    // fallback dedup by hostname + agentName
    const byHostname = await db
      .select({ id: machine.id })
      .from(machine)
      .where(and(eq(machine.agentName, params.agentName), sql`${machine.machineInfo}->>'hostname' = ${hostname}`))
      .limit(1);
    existingId = byHostname[0]?.id ?? null;
  }

  const now = new Date();

  if (existingId) {
    await db
      .update(machine)
      .set({
        status: "online",
        machineInfo: params.machineInfo,
        labels: params.labels,
        heartbeatIntervalMs: params.heartbeatIntervalMs,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(machine.id, existingId));

    await db.insert(registryEvent).values({
      id: genId("evt"),
      machineId: existingId,
      type: "register",
      detail: { machine_info: params.machineInfo, labels: params.labels },
    });

    return { id: existingId };
  }

  await db.insert(machine).values({
    id,
    organizationId: params.tenantId ?? null,
    userId: params.userId ?? null,
    agentName: params.agentName,
    status: "online",
    machineInfo: params.machineInfo,
    labels: params.labels,
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

  return { id };
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
