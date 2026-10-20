/**
 * Coordinator 的启动/停止桥接：Controller 维护活跃表与节点引用，Core 持有执行实体。
 * LaunchSpec 经宿主端口组装，业务注册表只在启动确认后提交。
 */

import { randomUUID } from "node:crypto";
import { log, error as logError, requestAls } from "@fenix/logger";
import type { Instance } from "@fenix/orchestration";
import { NotFoundError } from "@fenix/platform-sdk";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { getAgentRuntimeConfig } from "../server/config";
import { environmentRepo } from "../server/repositories/environment";
import { getAgentConfigLookupPort } from "../server/services/agent-config-lookup-port";
import { agentInstanceRuntimeCoordinator } from "../server/services/agent-instance-service";
import { getAgentLaunchSpecPort } from "../server/services/agent-launch-spec-port";
import { getBoundCoreRuntime as getCoreRuntime } from "../server/services/core-runtime-port";
import type { InstanceSpawnSource, InstanceSupplement } from "../types/instance";
import { beginSpawnReservation, releaseSpawnReservation } from "./agent-concurrency";
import { globalInstanceRegistry } from "./instance-registry";
import { getOrchestrationController } from "./orchestration-bootstrap";

const LOCAL_DEFAULT_NODE_ID = "local-default";

/**
 * 启动所需的最小实例身份：环境 + 属主。
 *
 * 模型/资源参数由组装方从环境行与其绑定配置解析，本层不传递运行时字段。
 */
export interface LaunchTargetRef {
  /** 来源环境 ID。 */
  readonly environmentId: string;
  /** 实例属主（真实用户身份，`environment.userId` 优先）。 */
  readonly userId: string;
}

const _deps = {
  environmentRepo,
  stopRuntime: (instanceId: string) => agentInstanceRuntimeCoordinator.stopRuntime({ id: instanceId }, "strict"),
  reclaimRuntime: (instanceId: string, generation?: number) =>
    agentInstanceRuntimeCoordinator.reclaimRuntime({ id: instanceId }, generation),
  // 内部函数引用：默认走真实 DB 构建；测试注入假实现以隔离 DB
  buildAgentLaunchSpecForCore,
  getOrchestrationController,
  // 停止后先断开 relay，再释放实时文档，防止引用残留。
  closeRelayConnectionsForStoppedInstance: (instanceId: string) =>
    import("../server/transport/relay/lifecycle-port").then(({ closeRelayConnectionsForStoppedInstance }) =>
      closeRelayConnectionsForStoppedInstance(instanceId),
    ),
  // 惰性获取避免与 chat-channel-bootstrap 的装配环。
  reclaimYjsDocs: (instanceId: string) =>
    import("../server/transport/relay/lifecycle-port").then(({ reclaimInstanceYjsDocs }) =>
      reclaimInstanceYjsDocs(instanceId),
    ),
};
const _defaultDeps = { ..._deps };

/** 测试用：覆盖内部依赖，避免 mock.module。 */
export function setOrchestrationInstanceDeps(overrides: Partial<typeof _deps>): void {
  Object.assign(_deps, overrides);
}

/** 测试用：恢复默认依赖。 */
export function resetOrchestrationInstanceDeps(): void {
  Object.assign(_deps, _defaultDeps);
}

/**
 * spawnInstanceViaController 的可选参数。
 */
export interface SpawnInstanceViaControllerOptions {
  /** 持久 Agent Instance uid；生命周期入口必须显式提供。 */
  instanceUid?: string;
  /**
   * 调用方环境变量覆盖，对齐旧路径 `{ ...platformEnv, ...extraEnv }` 的合并语义
   * （调用方显式传入的同名变量优先）。meta-agent 用它把共享 meta env 上的
   * USER_META_API_KEY / USER_META_USER_ID / USER_META_ORG_ID 覆盖为当前请求者上下文。
   */
  /** coordinator 分配的 runtime generation，本地与远程共用。 */
  runtimeGeneration?: number;
  /** 主服务进程 epoch，本地与远程共用。 */
  serverEpoch?: string;
  extraEnv?: Record<string, string>;
  /** 生命周期操作取消信号，不使用单请求等待者的 signal。 */
  signal?: AbortSignal;
}

/**
 * 经 Core 启动执行实体；节点使用 Controller 捕获的快照，避免节点与引用计数发生分歧。
 */
export async function spawnInstanceViaCore(
  target: LaunchTargetRef,
  instanceId: string,
  machineId: string,
  extraEnv?: Record<string, string>,
  runtimeFence?: { runtimeGeneration: number; serverEpoch: string },
  requestId?: string,
  signal?: AbortSignal,
): Promise<void> {
  const nodeId = machineId;

  signal?.throwIfAborted();
  const agentLaunchSpec = await _deps.buildAgentLaunchSpecForCore(target, extraEnv);
  signal?.throwIfAborted();

  const facade = getCoreRuntime();
  try {
    if (nodeId === "local-default") {
      // engineType 仅 local 执行时由上层传入；remote 时不传，由 machine 端自行决定。
      // 兜底值 = 本地默认引擎（peri）；部署可用 RCS_DEFAULT_ENGINE_TYPE 覆盖。
      await facade.launchInstance({
        instanceId,
        engineType: getAgentRuntimeConfig().defaultEngineType ?? "peri",
        nodeId,
        launchSpec: agentLaunchSpec,
        runtimeGeneration: runtimeFence?.runtimeGeneration,
        serverEpoch: runtimeFence?.serverEpoch,
      });
    } else {
      await facade.launchInstance({
        instanceId,
        nodeId,
        launchSpec: agentLaunchSpec,
        runtimeGeneration: runtimeFence?.runtimeGeneration,
        serverEpoch: runtimeFence?.serverEpoch,
      });
    }
  } catch (err) {
    logError(`[orchestration-instance] launchInstance failed: instanceId=${instanceId} nodeId=${nodeId}`, err, {
      requestId,
    });
    throw err;
  }
  log(`[orchestration-instance] launched via core: instanceId=${instanceId} nodeId=${nodeId}`, { requestId });
}

/**
 * 编排域完整启动入口：controller.spawnInstance（环境校验/并发检查/节点获取/Instance 创建）
 * 拿到 Instance 后，真正启动 Agent 进程并注册 RCS 业务补充信息，返回可用 Instance。
 *
 * @param source 实例启动来源，透传给 RCS supplement（spawn_source 审计字段），
 *               对齐旧 spawnInstanceFromEnvironment 的语义。
 * @param options 可选参数，extraEnv 按旧路径语义合并覆盖到 platformEnv。
 */
export async function spawnInstanceViaController(
  envId: string,
  userId: string,
  source: InstanceSpawnSource = "interactive",
  options: SpawnInstanceViaControllerOptions = {},
): Promise<Instance> {
  const requestId = requestAls.getStore()?.requestId ?? randomUUID();

  // 首条诊断日志：放在并发检查之前，被并发上限拒绝的启动同样留下关联 ID。
  // 独立入口（workflow / 定时任务 / 机器回传）没有上游请求上下文，自建的关联 ID 必须在这里落日志，
  // 否则它只出现在后续显式携带它的日志里，排障时无从知道这是同一次启动。
  log(
    `[orchestration-instance] spawn requested: instanceUid=${options.instanceUid ?? "n/a"} envId=${envId} source=${source}`,
    { requestId },
  );

  // 平台级/用户级并发治理：与旧 spawnInstanceFromEnvironment 首行语义对齐，
  // 并发配额统一由宿主 agent-concurrency reservation 管理；AgentController 禁止
  // 按 Environment 内存实例数重复限流。
  // 检查与 in-flight 预留合并为同一同步段（beginSpawnReservation 内部无 await），
  // 消除 "检查 → registerSupplement 注册" 窗口内并发不可见导致的同用户超发
  // （A-P2.1）；finally 兜底释放保证失败路径不永久占用额度。
  options.signal?.throwIfAborted();
  const reservation = beginSpawnReservation(userId, source, requestId);
  try {
    const controller = _deps.getOrchestrationController();
    if (!options.instanceUid) {
      throw new Error("INSTANCE_UID_REQUIRED");
    }
    const instance = await controller.spawnInstance(envId, userId, options.instanceUid);

    try {
      options.signal?.throwIfAborted();
      // 节点与引用计数共用 controller 的身份快照，禁止启动前重新解析节点。
      await spawnInstanceViaCore(
        { environmentId: envId, userId },
        instance.instanceId,
        instance.machineId,
        options.extraEnv,
        options.runtimeGeneration !== undefined && options.serverEpoch
          ? { runtimeGeneration: options.runtimeGeneration, serverEpoch: options.serverEpoch }
          : undefined,
        requestId,
        options.signal,
      );
      options.signal?.throwIfAborted();
      // 必须 await：registerSupplement 内部先查 env（DB 异步）再注册 supplement，
      // 不等待会让调用方（如 ensureRunning 的 spawnViaOrchestration）同步查
      // getInstance 时 supplement 尚未注册，误判实例不可见（INSTANCE_NOT_VISIBLE）。
      // 必须与 launch 同处 try：此处失败时 core 进程已启动、controller 活跃表已注册、
      // 节点 refCount 已 +1；若不做回滚，实例无 supplement，idle 监控（按 supplement
      // 判断）永不回收，成为仅 stopAllInstances 可清的永久孤儿。
      await registerSupplement(envId, userId, instance.instanceId, source, requestId);
      options.signal?.throwIfAborted();
    } catch (err) {
      // 回滚必须确认执行实体终止；失败交由 coordinator 保留 unknown。
      try {
        await stopInstanceViaController(instance.instanceId, "strict");
      } catch (rollbackErr) {
        logError(
          `[orchestration-instance] rollback stopInstance failed: instanceId=${instance.instanceId}`,
          rollbackErr,
          { requestId },
        );
        throw new AggregateError([err, rollbackErr], "Agent launch rollback failed");
      }
      throw err;
    }

    return instance;
  } finally {
    // 成功：registerSupplement 已完成，实例已计入正式统计，释放后口径无缝切换；
    // 失败（含 controller.spawnInstance 抛错，原 try 外路径）：实例不存在，
    // 释放避免额度永久占用。release 按引用幂等。
    releaseSpawnReservation(reservation);
  }
}

/**
 * 使用当前 AgentConfig 重新物化运行实例环境，供 ACP session/new 冻结 Skills 前调用。
 * 该操作复用现有 runtime，不重启进程或断开 relay。
 */
export async function refreshInstanceEnvironment(instanceId: string, envId: string, userId: string): Promise<void> {
  const agentLaunchSpec = await _deps.buildAgentLaunchSpecForCore({ environmentId: envId, userId });
  await getCoreRuntime().refreshInstanceEnvironment({ instanceId, launchSpec: agentLaunchSpec });
  log(`[orchestration-instance] refreshed environment: instanceId=${instanceId}`);
}

/**
 * 编排域完整停止入口：controller.stopInstance（停止帧 + 活跃表移除 + 节点引用归还）
 * + core facade.stopInstance（真正停止进程并清理 core 快照）+ RCS supplement 清理
 * + 实例名下内存 Y.Doc 回收（SP-C2，见函数末尾）。
 *
 * 组合原因：controller.stopInstance 只维护编排域内存状态，不会停止 core 侧进程，
 * 也不会清理 globalInstanceRegistry 的业务补充信息；单轮 HTTP 调用（openAgentSession）
 * 的 dispose 必须三者齐备，否则进程残留且实例列表出现脏数据。语义与旧
 * services/instance.ts 的 stopInstance 对齐；对重复 dispose / 已停止实例幂等。
 */
function isInstanceNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as Error & { code?: unknown }).code === "INSTANCE_NOT_FOUND"
  );
}

export async function stopInstanceViaController(
  instanceId: string,
  mode: "strict" | "best-effort" = "best-effort",
): Promise<void> {
  const controller = _deps.getOrchestrationController();
  const failures: unknown[] = [];
  try {
    await controller.stopInstance(instanceId);
  } catch (err) {
    if (!isInstanceNotFoundError(err)) failures.push(err);
    logError(`[orchestration-instance] controller.stopInstance failed: instanceId=${instanceId}`, err);
  }
  const facade = getCoreRuntime();
  try {
    await facade.stopInstance(instanceId);
  } catch (err) {
    // 同一错误码也用于「记录存在但 runtime entry 丢失」，不能把未知事实当作不存在。
    if (!isInstanceNotFoundError(err) || facade.getInstance(instanceId) !== null) failures.push(err);
    logError(`[orchestration-instance] core stopInstance failed: instanceId=${instanceId}`, err);
  }
  if (mode === "strict" && failures.length > 0) {
    throw new AggregateError(failures, `Failed to fully stop Agent Instance '${instanceId}'`);
  }
  globalInstanceRegistry.unregister(instanceId);
  // 先关闭消费者连接，再回收文档，确保引用与监听器配对释放。
  try {
    await _deps.closeRelayConnectionsForStoppedInstance(instanceId);
  } catch (err) {
    logError(`[orchestration-instance] yjs relay close failed after stop: instanceId=${instanceId}`, err);
  }
  // 运行实体确认停止后才能释放文档，避免丢弃仍在产生的输出。
  try {
    await _deps.reclaimYjsDocs(instanceId);
  } catch (err) {
    logError(`[orchestration-instance] yjs doc reclaim failed after stop: instanceId=${instanceId}`, err);
  }
}

/** stopInstancesForEnvironments 的可选参数。 */
export interface StopInstancesForEnvironmentsOptions {
  /**
   * 仅停止归属该组织的实例（多租户隔离；省略则不限制）。
   * 提供时只 stop 归属信息明确匹配的实例（supplement.organizationId /
   * launchSpec.organizationId）；无归属信息的 controller 幽灵实例保守跳过，
   * 避免跨租户误停（与 web DELETE /instances 的 403 语义一致）。
   */
  organizationId?: string;
}

/** 删除 Environment 前停止其全部运行实体；停止未确认时阻止删除，以保留恢复入口。 */
export async function stopInstancesForEnvironments(
  environmentIds: string[],
  options: StopInstancesForEnvironmentsOptions = {},
): Promise<string[]> {
  if (environmentIds.length === 0) return [];
  const envSet = new Set(environmentIds);

  // instanceId → 已知组织归属（undefined 表示来源无归属信息）
  const candidates = new Map<string, string | undefined>();

  for (const envId of environmentIds) {
    for (const [instanceId, sup] of globalInstanceRegistry.getByEnvironment(envId)) {
      candidates.set(instanceId, sup.organizationId);
    }
  }
  for (const snapshot of getCoreRuntime().listInstances()) {
    const envId = snapshot.launchSpec?.environmentId;
    // supplement 可能已丢失，core 快照的 launchSpec 携带组织归属；已在 registry
    // 收集到的实例不重复写入（supplement.organizationId 为归属权威来源，两者同源）
    if (envId && envSet.has(envId) && !candidates.has(snapshot.instanceId)) {
      candidates.set(snapshot.instanceId, snapshot.launchSpec.organizationId);
    }
  }
  for (const instance of _deps.getOrchestrationController().listInstances()) {
    if (envSet.has(instance.environmentId) && !candidates.has(instance.instanceId)) {
      // controller 幽灵：无 supplement / launchSpec 归属信息，仅当不限制组织时允许 stop
      candidates.set(instance.instanceId, undefined);
    }
  }

  const targetIds = [...candidates.entries()]
    .filter(([, organizationId]) => options.organizationId === undefined || organizationId === options.organizationId)
    .map(([instanceId]) => instanceId);
  if (targetIds.length === 0) return [];

  const results = await Promise.allSettled(targetIds.map((instanceId) => _deps.stopRuntime(instanceId)));
  const failed = results
    .map((result, index) => ({ result, instanceId: targetIds[index] }))
    .filter(({ result }) => result.status === "rejected");
  for (const { instanceId, result } of failed) {
    logError(
      `[instance-cleanup] stop failed: instanceId=${instanceId} (agent/env 删除清理)`,
      // Promise.allSettled 的联合类型无法经 filter 收窄，此处按 status === "rejected"
      // 已经过滤，reason 必然存在（与上方 filter 谓词配套）
      (result as PromiseRejectedResult).reason,
    );
  }
  log(`[instance-cleanup] envs=${environmentIds.length} instances=${targetIds.length} failed=${failed.length}`);
  if (failed.length > 0) {
    throw new AggregateError(
      failed.map(({ result }) => (result as PromiseRejectedResult).reason),
      "Environment instance stop could not be confirmed",
    );
  }
  return targetIds;
}

/**
 * 本地实例死亡清理的去重集合：同一实例并发到达多个死亡信号时只执行一次。
 */
const localDeadCleanupInFlight = new Set<string>();

/** 回收捕获身份仍匹配的本地死亡实体；共享本地节点不参与实例级清理。 */
export async function terminateLocalDeadInstance(
  instanceId: string,
  identity: { runtimeGeneration: number; serverEpoch: string },
): Promise<void> {
  // 1. 去重：并发死亡信号（yjs + workflow 同 handle 同时触发）只清理一次
  if (localDeadCleanupInFlight.has(instanceId)) return;
  try {
    const snapshot = getCoreRuntime().getInstance(instanceId);
    if (!snapshot || snapshot.nodeId !== LOCAL_DEFAULT_NODE_ID) return;
    if (snapshot.runtimeGeneration !== identity.runtimeGeneration || snapshot.serverEpoch !== identity.serverEpoch)
      return;
    if (snapshot.status !== "running" && snapshot.status !== "error") return;
    const controller = _deps.getOrchestrationController();
    if (!controller.listInstances().some((inst) => inst.instanceId === instanceId)) return;

    localDeadCleanupInFlight.add(instanceId);
    try {
      await _deps.reclaimRuntime(instanceId, snapshot.runtimeGeneration);
      log(`[local-relay-death] terminated dead local instance ${instanceId}`);
    } finally {
      localDeadCleanupInFlight.delete(instanceId);
    }
  } catch (err) {
    // 校验或清理过程中的任何异常都不得向上传播（fire-and-forget），
    // 由 idle monitor 兜底回收，避免死亡信号处理本身造成新的失败
    logError(`[local-relay-death] cleanup failed for ${instanceId}:`, err);
  }
}

/** 从宿主 LaunchSpec 端口组装启动载荷；用户与组织身份只由服务端环境注入。 */
async function buildAgentLaunchSpecForCore(
  target: LaunchTargetRef,
  extraEnv?: Record<string, string>,
): Promise<AgentLaunchSpec> {
  const env = await _deps.environmentRepo.getById(target.environmentId);
  if (!env) {
    throw new NotFoundError(`Environment '${target.environmentId}' not found`);
  }

  const platformEnv: Record<string, string> = {
    USER_META_API_KEY: env.secret,
    USER_META_BASE_URL: getAgentRuntimeConfig().baseUrl,
    USER_META_USER_ID: env.userId ?? target.userId,
    USER_META_ORG_ID: env.organizationId ?? "",
    // langfuse trace 的 user 维度：与 USER_META_USER_ID 同源（environment 属主优先），
    // peri 的 langfuse tracer 经 LANGFUSE_USER_ID 写入 TraceBody.user_id（动态，按实例注入）
    LANGFUSE_USER_ID: env.userId ?? target.userId,
  };
  // 对齐旧路径：调用方显式传入的同名环境变量优先
  const mergedExtraEnv = { ...platformEnv, ...extraEnv };
  const organizationId = env.organizationId ?? target.userId;
  const ownerUserId = target.userId;

  if (!env.agentConfigId) {
    // 无 agentConfigId 环境（历史遗留 / 系统级环境）走最小 LaunchSpec，等价旧路径
    // spawnInstanceFromEnvironment 的 buildBasicLaunchSpec 分支——不继承
    // prompt / skills / MCP 等额外配置。
    // 注意：编排域 controller.spawnInstance 会在更早阶段对无 agentConfigId 环境抛
    // LaunchSpecBuildError(422)，本分支通常不可达，仅作为防御性对齐保留（若编排域侧
    // 未来放宽启动约束，此处行为仍与旧路径一致）。
    // 无 agentConfigId 且无 machine 配置时：EnvironmentRepo 回退 local-default
    // （本地执行未禁用），与旧路径行为一致；禁用本地执行时 controller 阶段即拒绝。
    return getAgentLaunchSpecPort().buildMinimalAgentLaunchSpec({
      environmentId: target.environmentId,
      organizationId,
      ownerUserId,
      extraEnv: mergedExtraEnv,
    });
  }

  // 缓存 environmentId → machineId 映射，供 sendToAgentWs（Hermes/IM 通道）使用；
  // 与旧路径 spawnInstanceFromEnvironment 的 setAgentMachineCache 语义对齐。
  // 取一次投影而不是复用组装器读到的行：节点判定只在 agent-config（`resolveAgentNode`），
  // 本包不再持有资源行；代价是启动路径多一次已授权读（每次实例启动一次，非热路径）。
  const projection = await getAgentConfigLookupPort().findVisibleAgentConfig({
    agentConfigId: env.agentConfigId,
    organizationId,
    userId: ownerUserId,
  });
  // 配置不可读时不在这里报错：组装端口有自己的可见性判定，且错误语义必须与它一致
  // （`NotFoundError` + 同一个 message），否则同一故障会随"哪一步先读"改变形态。
  if (projection?.node?.kind === "machine") {
    // 运行时入口的服务聚合会回指本模块；仅在实例已进入启动流程后加载，避免模块初始化环。
    const { setAgentMachineCache } = await import("../server/transport/acp-ws-handler");
    setAgentMachineCache(target.environmentId, projection.node.machineId);
  }

  return getAgentLaunchSpecPort().buildAgentLaunchSpec({
    environmentId: target.environmentId,
    organizationId,
    ownerUserId,
    agentConfigId: env.agentConfigId,
    environmentSecret: env.secret,
    extraEnv: mergedExtraEnv,
  });
}

/** 补齐 Core 快照以外的属主与活动投影；查询失败由启动桥接执行整体回滚。 */
async function registerSupplement(
  envId: string,
  userId: string,
  instanceId: string,
  source: InstanceSpawnSource,
  requestId: string,
): Promise<void> {
  const env = await _deps.environmentRepo.getById(envId);
  const supplement: InstanceSupplement = {
    userId,
    environmentId: envId,
    organizationId: env?.organizationId ?? userId,
    spawnSource: source,
    requestId,
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: Date.now(),
  };
  globalInstanceRegistry.register(instanceId, supplement);
}
