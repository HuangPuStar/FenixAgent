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
import { environmentOrchestrationRepo, environmentRepo } from "../repositories";
import { setAgentMachineCache } from "../transport/acp-ws-handler";
import type { InstanceSpawnSource, InstanceSupplement } from "../types/store";
import { assertAgentConcurrencyAvailable } from "./agent-concurrency";
import { getReadableAgentConfigById } from "./config";
import { getCoreRuntime } from "./core-bootstrap";
import { globalInstanceRegistry } from "./instance-registry";
import { buildBasicLaunchSpec, buildLaunchSpec } from "./launch-spec-builder";
import { getOrchestrationController, getOrchestrationLaunchSpecBuilder } from "./orchestration-bootstrap";

/**
 * spawnInstanceViaController 的可选参数。
 */
export interface SpawnInstanceViaControllerOptions {
  /**
   * 调用方环境变量覆盖，对齐旧路径 `{ ...platformEnv, ...extraEnv }` 的合并语义
   * （调用方显式传入的同名变量优先）。meta-agent 用它把共享 meta env 上的
   * USER_META_API_KEY / USER_META_USER_ID / USER_META_ORG_ID 覆盖为当前请求者上下文。
   */
  extraEnv?: Record<string, string>;
}

/**
 * 通过 core runtime 真正启动 Agent 进程。
 *
 * nodeId 三选一（对齐旧 services/instance.ts 的节点选择逻辑）：
 *   1. 环境解析出的 machineId（agent_config.machineId → config.defaultMachineId →
 *      local-default，由编排域 EnvironmentRepo 完成 fallback）；
 *   2. config.defaultMachineId（防御性兜底）；
 *   3. "local-default"（本地节点）。
 * 注意：环境无 machineId 且本地执行被禁用（RCS_DISABLE_LOCAL_EXECUTION）时，
 * controller.spawnInstance 会先抛 LaunchSpecBuildError，因此走到本函数时
 * 第 2/3 分支仅在配置缺失或本地执行场景下可达，保留以对齐旧逻辑。
 *
 * @param launchSpec 编排域 LaunchSpec（仅取 environmentId/userId，运行时字段从 DB 重建）
 * @param instanceId 编排域 Instance 的 instanceId（与 core 实例一一对应）
 * @param extraEnv 调用方环境变量覆盖，透传给 buildAgentLaunchSpecForCore
 */
export async function spawnInstanceViaCore(
  launchSpec: LaunchSpec,
  instanceId: string,
  extraEnv?: Record<string, string>,
): Promise<void> {
  const envData = await environmentOrchestrationRepo.getEnvironment(launchSpec.environmentId);
  const nodeId = envData?.machineId ?? config.defaultMachineId ?? "local-default";

  const agentLaunchSpec = await buildAgentLaunchSpecForCore(launchSpec, extraEnv);

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
      await facade.launchInstance({ instanceId, nodeId, launchSpec: agentLaunchSpec });
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
  // 保证 RCS_AGENT_MAX_CONCURRENCY / RCS_USER_AGENT_MAX_CONCURRENCY 在
  // 编排域路径下仍然生效（controller 内部只检查环境级 maxConcurrency）。
  assertAgentConcurrencyAvailable(userId, source);

  const controller = getOrchestrationController();
  const instance = await controller.spawnInstance(envId, userId);

  try {
    // LaunchSpecBuilder 与 controller 内部构建重复（编排域未暴露已构建的 LaunchSpec）。
    // I4 过渡期可接受：两次构建均为只读 DB 查询；Phase C 后由包内统一。
    const launchSpec = await getOrchestrationLaunchSpecBuilder().build(envId, userId);
    await spawnInstanceViaCore(launchSpec, instance.instanceId, options.extraEnv);
  } catch (err) {
    // 回滚：core 启动失败（如远程节点离线）时清理编排域状态——活跃表条目 +
    // ensureNode 引用计数。否则实例仍计入环境并发额度（maxConcurrency=1 时一次
    // 失败启动后环境永久无法再启动），且节点引用永不清零导致空闲回收不触发。
    try {
      await controller.stopInstance(instance.instanceId);
    } catch (rollbackErr) {
      logError(`[orchestration-instance] rollback stopInstance failed: instanceId=${instance.instanceId}`, rollbackErr);
    }
    throw err;
  }

  registerSupplement(envId, userId, instance.instanceId, source);
  return instance;
}

/**
 * 编排域完整停止入口：controller.stopInstance（停止帧 + 活跃表移除 + 节点引用归还）
 * + core facade.stopInstance（真正停止进程并清理 core 快照）+ RCS supplement 清理。
 *
 * 组合原因：controller.stopInstance 只维护编排域内存状态，不会停止 core 侧进程，
 * 也不会清理 globalInstanceRegistry 的业务补充信息；单轮 HTTP 调用（openAgentSession）
 * 的 dispose 必须三者齐备，否则进程残留且实例列表出现脏数据。语义与旧
 * services/instance.ts 的 stopInstance 对齐；对重复 dispose / 已停止实例幂等。
 */
export async function stopInstanceViaController(instanceId: string): Promise<void> {
  const sup = globalInstanceRegistry.get(instanceId);
  const controller = getOrchestrationController();
  try {
    await controller.stopInstance(instanceId);
  } catch (err) {
    // 编排域实例可能已被停止或不在活跃表（重复 dispose / 外部回收），
    // 不阻断 core 进程停止与 supplement 清理。
    logError(`[orchestration-instance] controller.stopInstance failed: instanceId=${instanceId}`, err);
  }
  const facade = getCoreRuntime();
  try {
    await facade.stopInstance(instanceId);
  } catch (err) {
    // core 中实例可能已不存在（如 machine 断连时被清理），实例停止本身已由 controller 完成
    logError(`[orchestration-instance] core stopInstance failed: instanceId=${instanceId}`, err);
  }
  if (sup) {
    globalInstanceRegistry.unregister(instanceId);
    globalInstanceRegistry.deleteCounter(sup.environmentId);
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
  const env = await environmentRepo.getById(launchSpec.environmentId);
  if (!env) {
    throw new NotFoundError(`Environment '${launchSpec.environmentId}' not found`);
  }

  const platformEnv: Record<string, string> = {
    USER_META_API_KEY: env.secret,
    USER_META_BASE_URL: getBaseUrl(),
    USER_META_USER_ID: env.userId ?? launchSpec.userId,
    USER_META_ORG_ID: env.organizationId ?? "",
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
 */
async function registerSupplement(
  envId: string,
  userId: string,
  instanceId: string,
  source: InstanceSpawnSource,
): Promise<void> {
  const env = await environmentRepo.getById(envId);
  const supplement: InstanceSupplement = {
    userId,
    environmentId: envId,
    instanceNumber: globalInstanceRegistry.nextInstanceNumber(envId),
    organizationId: env?.organizationId ?? userId,
    spawnSource: source,
    lastActivityAt: Date.now(),
    relayCount: 0,
    lastRelayDetachedAt: Date.now(),
  };
  globalInstanceRegistry.register(instanceId, supplement);
}
