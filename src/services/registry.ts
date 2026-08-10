import { log } from "@fenix/logger";
import { and, desc, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, machine, organization, registryEvent } from "../db/schema";
import type { AuthContext } from "../plugins/auth";
import { markSandboxInstanceReadyByMachineId } from "../repositories/sandbox-instance-repository";
import { closeMachineFileWsConnection } from "../transport/file-ws-handler";

function genId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().slice(0, 22)}`;
}

function buildMachineOwnershipConditions(ctx: AuthContext) {
  return [
    eq(machine.organizationId, ctx.organizationId),
    or(isNull(machine.userId), eq(machine.userId, ctx.userId)),
  ] as const;
}

export async function listMachines(
  ctx: AuthContext,
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

  await db.insert(machine).values({
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
 * 删除 sandbox machine 记录（createSandboxMachine 的补偿路径）。
 *
 * 仅用于 sandbox-manager.createOrReuse 中"machine 行已插入但 sandbox_instance
 * 创建失败"的失败回滚（唯一索引冲突 / FK 缺失 / DB 错误），防止每次失败残留
 * 一条无主 mach_sandbox_* 记录。与 deleteMachine（管理面删除，含引用校验与
 * file-ws 清理）语义不同：此处机器从未注册运行，仅需删除行。
 */
export async function deleteSandboxMachine(id: string): Promise<void> {
  await db.delete(machine).where(eq(machine.id, id));
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

    // server 重启后 DB 状态可能过期，允许重连
    if (existing[0].status === "online") {
      log(`[registry] machine id '${params.machineId}' was already online (stale), allowing reconnection`);
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

    await markSandboxInstanceReadyByMachineId(params.machineId, now);
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

    await markSandboxInstanceReadyByMachineId(existingId, now);
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
 * 通用 registry 事件落库（P0-5，D18）。
 *
 * 供机器生命周期各路径复用：`deleteMachine` 的 retired 事件（本文件）、
 * file-ws-handler 的 degraded 落库（W1 预留钩子）与波次 4 W7 的告警。
 * 业务语义（type / detail）由调用方定义，本函数只负责生成事件 id 并插入，
 * 保证所有调用方的事件格式与落库行为一致。
 */
export async function writeRegistryEvent(
  machineId: string,
  type: string,
  detail: Record<string, unknown>,
): Promise<void> {
  await db.insert(registryEvent).values({
    id: genId("evt"),
    machineId,
    type,
    detail,
  });
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
  const ownershipConditions = buildMachineOwnershipConditions(ctx);
  const rows = await db
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

  await db
    .update(machine)
    .set(updates)
    .where(and(eq(machine.id, id), ...ownershipConditions));

  const updated = await db
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
export async function deleteMachine(ctx: AuthContext, id: string): Promise<{ deleted: true }> {
  const ownershipConditions = buildMachineOwnershipConditions(ctx);
  const rows = await db
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

  const referencedAgents = await db
    .select()
    .from(agentConfig)
    .where(and(eq(agentConfig.organizationId, ctx.organizationId), eq(agentConfig.machineId, id)))
    .limit(1);
  if (referencedAgents.length > 0) {
    throw new Error(`machine '${id}' is still referenced by agent configs`);
  }

  const orgRows = await db.select().from(organization).where(eq(organization.id, ctx.organizationId)).limit(1);
  const metadata = orgRows[0]?.metadata;
  const defaultMachineId =
    metadata && typeof metadata === "object"
      ? (((metadata as { defaultEngine?: { machineId?: string } }).defaultEngine?.machineId ?? "") as string)
      : "";
  if (defaultMachineId === id) {
    throw new Error(`machine '${id}' is still referenced by organization default engine`);
  }

  await db.delete(machine).where(and(eq(machine.id, id), ...ownershipConditions));

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
