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

/**
 * 管理员预创建机器记录（status=pending）。
 * 返回 machine id 和包含 RCS_MACHINE_ID + RCS_SECRET 的初始化命令。
 */
export async function createMachine(
  ctx: AuthContext,
  params: { name: string; labels?: string[]; agentName?: string },
): Promise<{ id: string; name: string; status: "pending"; initCommand: string }> {
  const id = genId("mach");
  const now = new Date();
  const agentName = params.agentName ?? "opencode";
  const labels = params.labels ?? [];

  await db.insert(machine).values({
    id,
    organizationId: ctx.organizationId,
    userId: null,
    agentName,
    name: params.name,
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
 * Machine 注册连接处理器。
 *
 * 仅负责运行时状态激活/重连（status、lastHeartbeatAt、updatedAt），
 * **不写入任何元数据字段**（name、labels、machineInfo 等）。
 * machine 必须在管理面通过 `POST /web/registry/machines` 预创建后才能连接，
 * 未预创建的连接将被拒绝（不再支持自动注册）。
 *
 * @param params.machineId - 客户端指定的 machine ID（优先），对应管理面预创建记录
 * @param params.nodeId - 客户端持久化的 node_id（去重用），用于未指定 machineId 时的回退匹配
 * @param params.agentName - 引擎名称，用于 bindAgentConfigs 自动匹配
 * @param params.tenantId - 组织 ID，用于 bindAgentConfigs 范围限定
 */
export async function registerMachine(params: {
  agentName: string;
  tenantId: string | null;
  nodeId?: string | null;
  machineId?: string | null;
}): Promise<{ id: string; isNew: boolean }> {
  let existingId: string | null = null;

  // ── 客户端指定 machineId 分支：验证预创建记录并激活 ──
  if (params.machineId) {
    const existing = await db
      .select({ id: machine.id, status: machine.status })
      .from(machine)
      .where(eq(machine.id, params.machineId))
      .limit(1);

    // machine 不存在：必须在组织管理界面先创建
    if (existing.length === 0) {
      throw new Error(`machine '${params.machineId}' not found, please create it first in your organization`);
    }

    const now = new Date();

    // 已在线：不允许另一个 client 接管
    if (existing[0].status === "online") {
      throw new Error(`machine id '${params.machineId}' is already online`);
    }

    const isFirstRegistration = existing[0].status === "pending";
    const eventType = isFirstRegistration ? "register" : "reconnect";

    // pending 或 offline → 激活为 online
    await db
      .update(machine)
      .set({
        status: "online",
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(machine.id, params.machineId));

    await db.insert(registryEvent).values({
      id: genId("evt"),
      machineId: params.machineId,
      type: eventType,
      detail: {},
    });

    await bindAgentConfigs(params.machineId, params.agentName, params.tenantId);
    return { id: params.machineId, isNew: isFirstRegistration };
  }

  // ── 去重策略（machineId 未指定时走此分支）──
  // 优先级 1：按客户端持久化的 node_id 精确匹配（最可靠，跨 IP/MAC 变化稳定）
  if (params.nodeId) {
    const byNodeId = await db.select({ id: machine.id }).from(machine).where(eq(machine.id, params.nodeId)).limit(1);
    existingId = byNodeId[0]?.id ?? null;
  }

  const now = new Date();

  // ── 已存在的机器重连：更新状态，写 reconnect 事件 ──
  if (existingId) {
    await db
      .update(machine)
      .set({
        status: "online",
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(machine.id, existingId));

    // 重连事件与首次注册区分，避免 registry_event 表堆积无意义的重复 register 记录
    await db.insert(registryEvent).values({
      id: genId("evt"),
      machineId: existingId,
      type: "reconnect",
      detail: {},
    });

    await bindAgentConfigs(existingId, params.agentName, params.tenantId);
    return { id: existingId, isNew: false };
  }

  throw new Error("machine not found, please create it first in your organization's admin panel");
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

/**
 * 由管理面调用，更新机器的名称、标签和引擎类型。
 * 仅允许组织管理员操作，校验组织归属。
 */
export async function updateMachine(
  ctx: AuthContext,
  id: string,
  params: { name?: string; labels?: string[]; agentName?: string },
): Promise<typeof machine.$inferSelect> {
  const rows = await db
    .select()
    .from(machine)
    .where(and(eq(machine.id, id), or(isNull(machine.organizationId), eq(machine.organizationId, ctx.organizationId))))
    .limit(1);

  if (rows.length === 0) {
    throw new Error(`machine '${id}' not found`);
  }

  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (params.name !== undefined) updates.name = params.name;
  if (params.labels !== undefined) updates.labels = params.labels;
  if (params.agentName !== undefined) updates.agentName = params.agentName;

  await db.update(machine).set(updates).where(eq(machine.id, id));

  const updated = await db.select().from(machine).where(eq(machine.id, id)).limit(1);
  return updated[0];
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
