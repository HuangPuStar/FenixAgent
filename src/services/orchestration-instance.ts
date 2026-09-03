/**
 * 编排域启动桥接（I4 集成第二阶段）：让新包创建的 Instance 真正启动 Agent 进程。
 *
 * 背景：`packages/orchestration` 的 AgentNode._spawnInstance 只创建内存 Instance，
 * 不接触 core runtime；真正启动进程的权威路径是 `getCoreRuntime().launchInstance`。
 * 不改新包代码，在本层包装：controller.spawnInstance（编排域校验 + 生命周期）→
 * 组装 core 的 AgentLaunchSpec → launchInstance（真实启动）。
 *
 * 过渡期说明：编排域 LaunchSpec 是扁平聚合视图，缺少 model 的 baseUrl/apiKey/
 * protocol、skills 下载地址、MCP 详细配置等运行时字段，无法直接作为 core 的
 * AgentLaunchSpec。这里复用旧 launch-spec-builder 从 DB 重建完整 AgentLaunchSpec，
 * 与 services/instance.ts 的构建路径保持一致。Phase C 迁移调用方后，应把该构建
 * 收敛回编排域 LaunchSpec 的数据面，避免双份构建。
 */

import { log, error as logError } from "@fenix/logger";
import type { Instance, LaunchSpec } from "@fenix/orchestration";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { config, getBaseUrl } from "../config";
import { NotFoundError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import { environmentRepo } from "../repositories";
import { setAgentMachineCache } from "../transport/acp-ws-handler";
import type { InstanceSpawnSource, InstanceSupplement } from "../types/store";
import { beginSpawnReservation, releaseSpawnReservation } from "./agent-concurrency";
import { getReadableAgentConfigById } from "./config";
import { getCoreRuntime } from "./core-bootstrap";
import { globalInstanceRegistry } from "./instance-registry";
import { buildBasicLaunchSpec, buildLaunchSpec } from "./launch-spec-builder";
import { LOCAL_DEFAULT_NODE_ID } from "./local-node-service";
import { getOrchestrationController, getOrchestrationLaunchSpecBuilder } from "./orchestration-bootstrap";

const _deps = {
  environmentRepo,
  // 内部函数引用：默认走真实 DB 构建；测试注入假实现以隔离 DB
  buildAgentLaunchSpecForCore,
  getOrchestrationController,
  getOrchestrationLaunchSpecBuilder,
  // SP-C2：实例停止完成后关闭前端 YJS client。仅回收 Doc 不会断开浏览器连接，
  // shared relay 及 listener 会残留为 Observer 中的孤儿 chat-relay；惰性导入避免
  // 与 chat-channel-bootstrap 的模块循环，测试可注入 spy 验证顺序。
  closeRelayConnectionsForStoppedInstance: (instanceId: string) =>
    import("../transport/relay").then(({ closeRelayConnectionsForStoppedInstance }) =>
      closeRelayConnectionsForStoppedInstance(instanceId),
    ),
  // SP-C2：实例停止完成后回收其内存 Y.Doc。默认经 transport/relay 惰性导入
  // （避免与 chat-channel-bootstrap 的模块循环，同 acp-idle-monitor 的既有模式）；
  // 测试注入 spy 验证接线，不依赖真实控制器装配。
  reclaimYjsDocs: (instanceId: string) =>
    import("../transport/relay").then(({ reclaimInstanceYjsDocs }) => reclaimInstanceYjsDocs(instanceId)),
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
  /** coordinator 分配的 runtime generation；远程启动时必填。 */
  runtimeGeneration?: number;
  /** 主服务进程 epoch；远程启动时必填。 */
  serverEpoch?: string;
  extraEnv?: Record<string, string>;
}

/**
 * 通过 core runtime 真正启动 Agent 进程。
 *
 * nodeId 直接取 `Instance.machineId`：它是 controller.spawnInstance 内部同一次
 * environmentRepo.getEnvironment 解析出的 machineId（fallback 链 agent_config.machineId
 * → config.defaultMachineId → local-default 由宿主 EnvironmentRepo 完成），与
 * ensureNode 的节点获取严格同源。不得在本函数内重读 env 重新解析——否则与 controller
 * 形成两次读取，期间 agent_config.machineId 被修改时，refCount 会记在旧节点而实例
 * 实际启动在新节点（A-P2.2 TOCTOU）。
 *
 * local-default 分支：engineType 仅 local 执行时由上层传入（config.defaultEngineType）；
 * remote 时不传，由 machine 端自行决定（对齐旧 services/instance.ts 的节点选择逻辑）。
 *
 * @param launchSpec 编排域 LaunchSpec（仅取 environmentId/userId，运行时字段从 DB 重建）
 * @param instanceId 编排域 Instance 的 instanceId（与 core 实例一一对应）
 * @param machineId controller 已解析的节点标识（Instance.machineId 快照，禁止重读 env 推导）
 * @param extraEnv 调用方环境变量覆盖，透传给 buildAgentLaunchSpecForCore
 */
export async function spawnInstanceViaCore(
  launchSpec: LaunchSpec,
  instanceId: string,
  machineId: string,
  extraEnv?: Record<string, string>,
  runtimeFence?: { runtimeGeneration: number; serverEpoch: string },
): Promise<void> {
  const nodeId = machineId;

  const agentLaunchSpec = await _deps.buildAgentLaunchSpecForCore(launchSpec, extraEnv);

  const facade = getCoreRuntime();
  try {
    if (nodeId === "local-default") {
      // engineType 仅 local 执行时由上层传入；remote 时不传，由 machine 端自行决定
      await facade.launchInstance({
        instanceId,
        engineType: config.defaultEngineType ?? "opencode",
        nodeId,
        launchSpec: agentLaunchSpec,
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
    logError(`[orchestration-instance] launchInstance failed: instanceId=${instanceId} nodeId=${nodeId}`, err);
    throw err;
  }
  log(`[orchestration-instance] launched via core: instanceId=${instanceId} nodeId=${nodeId}`);
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
  // 平台级/用户级并发治理：与旧 spawnInstanceFromEnvironment 首行语义对齐，
  // 并发配额统一由宿主 agent-concurrency reservation 管理；AgentController 禁止
  // 按 Environment 内存实例数重复限流。
  // 检查与 in-flight 预留合并为同一同步段（beginSpawnReservation 内部无 await），
  // 消除 "检查 → registerSupplement 注册" 窗口内并发不可见导致的同用户超发
  // （A-P2.1）；finally 兜底释放保证失败路径不永久占用额度。
  const reservation = beginSpawnReservation(userId, source);
  try {
    const controller = _deps.getOrchestrationController();
    if (!options.instanceUid) {
      throw new Error("INSTANCE_UID_REQUIRED");
    }
    const instance = await controller.spawnInstance(envId, userId, options.instanceUid);

    try {
      // LaunchSpecBuilder 与 controller 内部构建重复（编排域未暴露已构建的 LaunchSpec）。
      // I4 过渡期可接受：两次构建均为只读 DB 查询；Phase C 后由包内统一。
      const launchSpec = await _deps.getOrchestrationLaunchSpecBuilder().build(envId, userId);
      // instance.machineId 与 controller 内部 ensureNode 使用同一快照（同一次 env 读取的
      // 解析结果），保证 refCount 节点与 core nodeId 一致（A-P2.2）；禁止改回重读 env。
      await spawnInstanceViaCore(
        launchSpec,
        instance.instanceId,
        instance.machineId,
        options.extraEnv,
        options.runtimeGeneration !== undefined && options.serverEpoch
          ? { runtimeGeneration: options.runtimeGeneration, serverEpoch: options.serverEpoch }
          : undefined,
      );
      // 必须 await：registerSupplement 内部先查 env（DB 异步）再注册 supplement，
      // 不等待会让调用方（如 ensureRunning 的 spawnViaOrchestration）同步查
      // getInstance 时 supplement 尚未注册，误判实例不可见（INSTANCE_NOT_VISIBLE）。
      // 必须与 launch 同处 try：此处失败时 core 进程已启动、controller 活跃表已注册、
      // 节点 refCount 已 +1；若不做回滚，实例无 supplement，idle 监控（按 supplement
      // 判断）永不回收，成为仅 stopAllInstances 可清的永久孤儿。
      await registerSupplement(envId, userId, instance.instanceId, source);
    } catch (err) {
      // 回滚三侧状态：controller 活跃表 + 节点引用归还（controller.stopInstance）、
      // core 进程（facade.stopInstance）、supplement 清理。stopInstanceViaController
      // 对两处 stop 均幂等吞错：launch 失败（core 无实例）与 supplement 注册失败
      // （registry 无条目）两种场景同样安全。
      try {
        await stopInstanceViaController(instance.instanceId);
      } catch (rollbackErr) {
        logError(
          `[orchestration-instance] rollback stopInstance failed: instanceId=${instance.instanceId}`,
          rollbackErr,
        );
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
  const launchSpec = await _deps.getOrchestrationLaunchSpecBuilder().build(envId, userId);
  const agentLaunchSpec = await _deps.buildAgentLaunchSpecForCore(launchSpec);
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
    if (!isInstanceNotFoundError(err)) failures.push(err);
    logError(`[orchestration-instance] core stopInstance failed: instanceId=${instanceId}`, err);
  }
  globalInstanceRegistry.unregister(instanceId);
  // SP-C2：停止成功后先关闭该 instance 的所有前端 YJS client，使 gateway close
  // 生命周期释放 shared relay/refCount/listener；随后才 reclaim Doc。关闭失败不得改变
  // 停止语义，但必须保留诊断信息，否则 Observer 会持续显示孤儿 chat-relay。
  try {
    await _deps.closeRelayConnectionsForStoppedInstance(instanceId);
  } catch (err) {
    logError(`[orchestration-instance] yjs relay close failed after stop: instanceId=${instanceId}`, err);
  }
  // 实例停止完成点统一回收其名下内存 Y.Doc（idle reclaim、terminateLocalDeadInstance、
  // 手动停止等都汇聚到本函数；远程机器幽灵清理由 orchestration-machine-cleanup 对每个
  // 实例单独触发同一回收）。必须发生在停止之后：实例可能存活时关 Doc 会丢弃实时流。
  // 回收失败不改变停止语义（Doc 泄漏由周期日志的 openedDocCount 观测暴露）。
  try {
    await _deps.reclaimYjsDocs(instanceId);
  } catch (err) {
    logError(`[orchestration-instance] yjs doc reclaim failed after stop: instanceId=${instanceId}`, err);
  }
  if (mode === "strict" && failures.length > 0) {
    throw new AggregateError(failures, `Failed to fully stop Agent Instance '${instanceId}'`);
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

/**
 * 批量停止指定 environment 下的全部运行实例（agent / environment 删除时的资源回收入口）。
 *
 * 背景：删除 agent_config / environment 的 DB 行不会停止其运行中的编排实例，Agent
 * 进程、controller 活跃表、registry supplement / env 计数与节点 refCount 全部残留，
 * 永久占用并发额度（详见 docs/issues/2026-08-19-agent-delete-instance-leak.md）。
 * idle monitor 对 spawnSource === "interactive" 直接跳过、scheduled/system 需等待
 * 硬超时，均无法及时回收——删除路径必须在删 DB 前调用本 helper 主动释放。
 *
 * 三路收集（同一 instanceId 只 stop 一次）：
 *   1. primary：globalInstanceRegistry.getByEnvironment —— 有 supplement 的正常实例；
 *   2. core facade.listInstances 按 launchSpec.environmentId 过滤 —— 补 supplement
 *      丢失的边际（core 快照仍在，进程仍活）；
 *   3. controller.listInstances 按 environmentId 过滤 —— 补 controller 幽灵
 *      （supplement 与 core 均已清，仅活跃表仍持有）。
 *
 * 失败语义：单个实例 stop 失败不中断整体（Promise.allSettled），逐条 logError；
 * 调用方（删除流程）仍继续执行 DB 删除，残留实例由 idle monitor / 超时兜底。
 * 三路收集阶段若抛错（runtime 不可用等系统级故障）则向上抛：调用方删除中断、
 * DB 行保留可重试，避免在 runtime 状态未知时静默删除留下孤儿实例（fail-closed）。
 *
 * @param environmentIds 目标 environment 列表；为空时直接返回。
 * @param options 可选参数（organizationId 多租户隔离）。
 * @returns 被 stop 的 instanceId 列表（供调用方聚合日志观测）。
 */
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

  const results = await Promise.allSettled(targetIds.map((instanceId) => stopInstanceViaController(instanceId)));
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
  return targetIds;
}

/**
 * 本地实例死亡清理的去重集合：同一实例并发到达多个死亡信号时只执行一次。
 */
const localDeadCleanupInFlight = new Set<string>();

/**
 * 清理已确认死亡的本地实例（C-P2.4）。
 *
 * 设计原因：local-default 节点是 N:1 共享节点（一个 stub socket 承载全部本地实例，
 * 见 local-node-service.ts），实例状态由节点状态推导（instance.ts:66-71），节点级
 * 断连会把健康本地实例一并标记 error 甚至误杀，因此死亡处理必须落在实例粒度。
 * 本函数是远程机器断连清理（orchestration-machine-cleanup）的本地对应物，差异仅在
 * 于按实例而非按机器匹配，且由 relay 死亡信号触发而非机器 WS 关闭触发。
 *
 * 前置校验（任一不满足即静默跳过，保证幂等与不误伤）：
 *   1. core 快照存在且 nodeId === "local-default"（远程实例由 E-P0.1 机器级清理
 *      覆盖，其内存 Y.Doc 由 orchestration-machine-cleanup 触发同一回收，SP-C2
 *      funnel 不因该路径缺位）；
 *   2. 快照状态为 running 或 error（error 覆盖 connectRelay 失败被 markInstanceError
 *      的实例——该状态被 idle monitor 默认 sweep 排除，是唯一的永久泄漏路径）；
 *   3. 实例仍在编排域活跃表（已被 stop/清理的实例跳过，避免重复 stop 的噪音日志）。
 *
 * fire-and-forget 语义：本函数永不抛错（校验与清理均在 try 内，失败吞错并记日志）；
 * 清理失败保留实例由 idle monitor 兜底。
 *
 * 已知限制：无任何 relay 消费者且进程死亡的本地实例（无人连接、relay handle 不存在）
 * 不产生死亡信号，仍由 idle monitor 300s 兜底回收——该场景无用户可见影响；
 * 移除条件：core 暴露进程退出事件（onInstanceExited）后切换到该信号。
 */
export async function terminateLocalDeadInstance(instanceId: string): Promise<void> {
  // 1. 去重：并发死亡信号（yjs + workflow 同 handle 同时触发）只清理一次
  if (localDeadCleanupInFlight.has(instanceId)) return;
  try {
    const snapshot = getCoreRuntime().getInstance(instanceId);
    if (!snapshot || snapshot.nodeId !== LOCAL_DEFAULT_NODE_ID) return;
    if (snapshot.status !== "running" && snapshot.status !== "error") return;
    const controller = _deps.getOrchestrationController();
    if (!controller.listInstances().some((inst) => inst.instanceId === instanceId)) return;

    localDeadCleanupInFlight.add(instanceId);
    try {
      await stopInstanceViaController(instanceId);
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

/**
 * 从编排域 LaunchSpec 重建 core 的 AgentLaunchSpec。
 *
 * 编排域数据面（扁平聚合）不含 model 密钥 / skills 下载地址 / MCP 详细配置，
 * 复用旧 buildLaunchSpec 从 DB 完整解析，保证与既有 spawnInstanceFromEnvironment
 * 路径产出的运行时配置一致。platformEnv（USER_META_*）注入也与之对齐，
 * extraEnv 可覆盖同名默认值。
 *
 * @param extraEnv 调用方环境变量覆盖，按旧路径 `{ ...platformEnv, ...extraEnv }`
 *                 语义合并（显式传入的同名变量优先）。
 */
async function buildAgentLaunchSpecForCore(
  launchSpec: LaunchSpec,
  extraEnv?: Record<string, string>,
): Promise<AgentLaunchSpec> {
  const env = await _deps.environmentRepo.getById(launchSpec.environmentId);
  if (!env) {
    throw new NotFoundError(`Environment '${launchSpec.environmentId}' not found`);
  }

  const platformEnv: Record<string, string> = {
    USER_META_API_KEY: env.secret,
    USER_META_BASE_URL: getBaseUrl(),
    USER_META_USER_ID: env.userId ?? launchSpec.userId,
    USER_META_ORG_ID: env.organizationId ?? "",
    // langfuse trace 的 user 维度：与 USER_META_USER_ID 同源（environment 属主优先），
    // peri 的 langfuse tracer 经 LANGFUSE_USER_ID 写入 TraceBody.user_id（动态，按实例注入）
    LANGFUSE_USER_ID: env.userId ?? launchSpec.userId,
  };
  // 对齐旧路径：调用方显式传入的同名环境变量优先
  const mergedExtraEnv = { ...platformEnv, ...extraEnv };

  if (!env.agentConfigId) {
    // 无 agentConfigId 环境（历史遗留 / 系统级环境）走最小 LaunchSpec，等价旧路径
    // spawnInstanceFromEnvironment 的 buildBasicLaunchSpec 分支——不继承
    // prompt / skills / MCP 等额外配置。
    // 注意：编排域 controller.spawnInstance 的 LaunchSpecBuilder 会在更早阶段对
    // 无 agentConfigId 环境抛 LaunchSpecBuildError(422)，本分支通常不可达，仅作为
    // 防御性对齐保留（若编排域侧未来放宽构建约束，此处行为仍与旧路径一致）。
    // 无 agentConfigId 且无 machine 配置时：EnvironmentRepo 回退 local-default
    // （本地执行未禁用），与旧路径行为一致；禁用本地执行时 controller 阶段即拒绝。
    return buildBasicLaunchSpec({
      organizationId: env.organizationId ?? launchSpec.userId,
      userId: launchSpec.userId,
      environmentId: launchSpec.environmentId,
      extraEnv: mergedExtraEnv,
    });
  }

  const accessCtx: AuthContext = {
    organizationId: env.organizationId ?? "",
    userId: launchSpec.userId,
    role: "owner",
  };
  const agentConfig = await getReadableAgentConfigById(accessCtx, env.agentConfigId);
  if (!agentConfig) {
    throw new NotFoundError(`AgentConfig '${env.agentConfigId}' not found`);
  }
  // 缓存 environmentId → machineId 映射，供 sendToAgentWs（Hermes/IM 通道）使用；
  // 与旧路径 spawnInstanceFromEnvironment 的 setAgentMachineCache 语义对齐。
  if (agentConfig.machineId) {
    setAgentMachineCache(launchSpec.environmentId, agentConfig.machineId);
  }

  return buildLaunchSpec({
    organizationId: env.organizationId ?? launchSpec.userId,
    userId: launchSpec.userId,
    environmentId: launchSpec.environmentId,
    agentConfig,
    environmentSecret: env.secret,
    extraEnv: mergedExtraEnv,
  });
}

/**
 * 注册 RCS 业务层补充信息（与旧 spawnInstanceFromEnvironment 对齐）。
 *
 * core 只维护运行时快照，RCS 侧的前端实例列表、活动观测、空闲回收都依赖
 * globalInstanceRegistry 的 supplement；缺失会导致启动后的实例不可见、
 * 机器回传消息无法关联活动。
 *
 * 失败语义：本函数失败（env DB 查询抛错）由调用方 spawnInstanceViaController
 * 的 try/catch 回滚整个实例（controller 活跃表 + core 进程 + supplement 三侧）。
 * envCounter 在 getById 之后才递增，故失败时无编号残留，无需补偿。
 */
async function registerSupplement(
  envId: string,
  userId: string,
  instanceId: string,
  source: InstanceSpawnSource,
): Promise<void> {
  const env = await _deps.environmentRepo.getById(envId);
  const supplement: InstanceSupplement = {
    userId,
    environmentId: envId,
    organizationId: env?.organizationId ?? userId,
    spawnSource: source,
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: Date.now(),
  };
  globalInstanceRegistry.register(instanceId, supplement);
}
