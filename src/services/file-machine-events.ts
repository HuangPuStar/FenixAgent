// file-machine-events.ts — 机器端文件变更事件接收与治理（docs/arch/12-files.md §7.5）
//
// 自 file-ws-handler 拆出的 W7 事件侧逻辑（保持 handler 单文件 ≤500 行，CLAUDE.md）。
// 职责边界：
// - register 环境声明：≤500 上限（超限拒绝新声明 + registryEvent）；旧机器端无
//   environments 字段 → 宽松模式放行 + 告警日志（兼容过渡，机器端升级前不硬阻塞）；
// - register 身份绑定（W11，§7.1）：对账 core runtime node 注册；严格模式未知
//   machine → close 4404（宽松模式放行 + 告警，两阶段过渡软开关）；
// - 帧校验与发布：file_changed / file_changed_batch / environment_declared，
//   不在权威环境集 → 丢弃 + registryEvent 告警（不静默，§7.5）；
// - 主服务记账：file_op 首现某环境登记 machine→environment 映射，与声明合并成
//   权威环境集（消除"兜底依赖声明、声明又滞后"的鸡生蛋）；
// - invalidate_all 广播治理（§7.3 断连窗口兜底三件套）：机器级限频 ≤2 条/s，
//   超限合并跳过；分发加随机抖动 0-5s 防重连风暴；
// - degraded 发布（T7 能力降级可见）：限频 1 条/30s/environment。
//
// 发布链：本模块 → file-event-limiter（限频合并，D20 增量 batch）→ file-event-queue
// （异步、按环境 fan-out、溢出收敛 invalidate_all）。本模块不直接碰队列发布。

import { createLogger, error as logError } from "@fenix/logger";
import { config } from "../config";
import type { FileWsConnectionEntry } from "../types/store";
import { getCoreRuntime } from "./core-bootstrap";
import {
  type FileChangeKind,
  type FileChangeSource,
  publishDegradedLimited,
  publishFileChanged,
  publishInvalidateAllLimited,
} from "./file-event-limiter";
import { registerEnvironmentQueue } from "./file-event-queue";
import { writeRegistryEvent } from "./registry";

const logger = createLogger("file-machine-events");

/** 单机器可声明的环境数量上限；超限拒绝新声明并落库 registryEvent（管理面可见） */
const MAX_DECLARED_ENVIRONMENTS = 500;
/** 机器级 invalidate_all 广播限频：≤2 条/s（治理三件套，§7.3） */
const MACHINE_INVALIDATE_LIMIT = 2;
/** invalidate_all 分发随机抖动上限 0-5s（防重连风暴） */
const INVALIDATE_JITTER_MAX_MS = 5_000;

// ── 模块级状态（与 handler 连接索引同生命周期：sweep/退役/优雅关闭时清理）──
/** machineId → 权威环境集（声明 ∪ file_op 记账） */
const machineEnvironments = new Map<string, Set<string>>();
/** 声明严格模式机器：register 携带 environments 字段 → 事件只接受权威集内环境 */
const strictMachines = new Set<string>();
/** 机器级 invalidate_all 广播限频窗口（2 条/s） */
const machineInvalidateRate = new Map<string, { start: number; count: number }>();

const CHANGE_KINDS = new Set<FileChangeKind>(["write", "delete", "mkdir", "rename", "upload"]);
const CHANGE_SOURCES = new Set<FileChangeSource>(["user", "agent", "api"]);

function isChangeKind(value: unknown): value is FileChangeKind {
  return typeof value === "string" && (CHANGE_KINDS as Set<string>).has(value);
}

function isChangeSource(value: unknown): value is FileChangeSource {
  return typeof value === "string" && (CHANGE_SOURCES as Set<string>).has(value);
}

/** 读取（或惰性创建）该机器权威环境集 */
function getMachineEnvironments(machineId: string): Set<string> {
  let set = machineEnvironments.get(machineId);
  if (!set) {
    set = new Set();
    machineEnvironments.set(machineId, set);
  }
  return set;
}

/**
 * 记账登记单个环境（file_op 首现 / 增量声明 / register 声明共用）并保活队列。
 * 权威集达到上限后拒绝继续登记（与声明超限语义一致，防恶意刷环境）。
 */
export function registerMachineEnvironment(machineId: string, envId: string): void {
  if (getMachineEnvironments(machineId).size >= MAX_DECLARED_ENVIRONMENTS) {
    return;
  }
  getMachineEnvironments(machineId).add(envId);
  registerEnvironmentQueue(envId);
}

/**
 * 合并一批环境声明进权威集；合并后超限（>500）→ 拒绝该次声明并落库 registryEvent。
 * 声明侧调用的"拒绝"语义 = 忽略新声明，机器注册本身不受影响
 * （§7.5：拒绝新声明并记录 registryEvent，管理面可见，不做硬阻塞）。
 */
function mergeDeclaredEnvironments(machineId: string, declared: string[]): boolean {
  const merged = new Set(getMachineEnvironments(machineId));
  for (const env of declared) {
    merged.add(env);
  }
  if (merged.size > MAX_DECLARED_ENVIRONMENTS) {
    writeEventWarning(machineId, "environment_declaration_rejected", {
      count: merged.size,
      limit: MAX_DECLARED_ENVIRONMENTS,
    });
    return false;
  }
  machineEnvironments.set(machineId, merged);
  for (const env of declared) {
    registerEnvironmentQueue(env);
  }
  return true;
}

/**
 * registryEvent 告警落库：异步 fire-and-forget（不阻断消息循环），
 * 失败保留诊断上下文，不静默吞错。
 * Promise.resolve 包装兼容测试注入的惰性 stub（未配置时返回 undefined）——
 * W11 起 register 宽松放行路径也会在未 stub 的测试中触发本函数。
 */
function writeEventWarning(machineId: string, type: string, detail: Record<string, unknown>): void {
  logger.warn(`[file-ws-events] ${type}: machine=${machineId} detail=${JSON.stringify(detail)}`);
  Promise.resolve(writeRegistryEvent(machineId, type, detail)).catch((err) => {
    logError(`file-ws registryEvent write failed: type=${type} machine=${machineId}`, err);
  });
}

/**
 * 处理 register 帧的环境声明（§7.5）：携带 environments（≤500）→ 与既有记账合并成
 * 权威环境集并进入严格模式（事件只接受权威集内环境）；旧机器端无 environments
 * → 宽松模式放行 + 告警日志（兼容过渡）。register 成功后由调用方广播 invalidate_all。
 */
export function registerMachineDeclaration(machineId: string, rawEnvs: unknown): void {
  if (Array.isArray(rawEnvs)) {
    const declared = rawEnvs.filter((e): e is string => typeof e === "string" && e !== "");
    if (mergeDeclaredEnvironments(machineId, declared)) {
      strictMachines.add(machineId);
    }
  } else {
    strictMachines.delete(machineId);
    logger.warn(`file-ws register without environments, lenient mode: machineId=${machineId}`);
  }
}

/**
 * W11 身份绑定（§7.1，P2-14）：register 对账 core runtime node 注册。
 *
 * 对账查询面是 registerRemoteNode 产物（acp-ws 注册链），不查 DB machine 表——
 * pending/offline 机器也会通过校验，语义错误。node 存在即放行（不检查 status：
 * 对账面只要求"曾完成 acp-ws 注册"）。未知 machine：严格模式（config.fileWsIdentityStrict，
 * 默认 false 宽松）close(4404) 并返回 true（调用方必须中止注册流程）；宽松模式放行
 * 并落库 registryEvent 告警（§7.4 可观测）。4404 位于应用自定义段（4000-4999），
 * 与 YJS 4004（终态不重试）语义不同：unknown_machine 可重试——服务端重启后机器
 * file-ws 可能先于 acp-ws 到达（时序窗口），机器端据此退避重试（跨仓库契约）。
 * 两阶段过渡软开关：旧机器端无 4404 退避语义，服务端先上严格校验会硬阻塞（§10）。
 */
export function handleFileWsRegisterIdentity(entry: FileWsConnectionEntry, machineId: string): boolean {
  const node = getCoreRuntime()?.getNode(machineId);
  if (node) return false;
  if (config.fileWsIdentityStrict) {
    logger.warn(`file-ws register rejected (unknown_machine): machineId=${machineId} wsId=${entry.wsId}`);
    writeEventWarning(machineId, "unknown_machine_rejected", { wsId: entry.wsId });
    try {
      entry.ws.close(4404, "unknown_machine");
    } catch {
      // 连接已处于异常状态时 close 抛错；close 事件回调（handleFileWsClose）完成索引清理
    }
    return true;
  }
  logger.warn(`file-ws register from unknown machine (lenient): machineId=${machineId} wsId=${entry.wsId}`);
  writeEventWarning(machineId, "unknown_machine_lenient", { wsId: entry.wsId });
  return false;
}

/**
 * 事件环境校验：宽松模式（未声明）放行；严格模式仅接受权威集内环境，
 * 不在权威集 → 丢弃 + registryEvent 告警（不静默，§7.5）。
 */
function isEnvironmentAccepted(machineId: string, envId: string): boolean {
  if (!strictMachines.has(machineId)) {
    return true;
  }
  if (getMachineEnvironments(machineId).has(envId)) {
    return true;
  }
  writeEventWarning(machineId, "file_changed_environment_rejected", { environment_id: envId });
  return false;
}

/** 校验并发布一条 file_changed（单帧与 batch 条目共用） */
function publishMachineFileChanged(
  machineId: string,
  envId: string,
  rawPath: unknown,
  rawKind: unknown,
  rawSource: unknown,
  rawActorId: unknown,
  rawTo?: unknown,
): void {
  if (typeof rawPath !== "string" || rawPath === "" || !isChangeKind(rawKind)) {
    writeEventWarning(machineId, "invalid_file_changed", { environment_id: envId, reason: "invalid path or kind" });
    return;
  }
  publishFileChanged(
    envId,
    {
      path: rawPath,
      kind: rawKind,
      source: isChangeSource(rawSource) ? rawSource : "agent",
      ...(typeof rawActorId === "string" && rawActorId !== "" ? { actorId: rawActorId } : {}),
      ...(typeof rawTo === "string" && rawTo !== "" ? { to: rawTo } : {}),
    },
    { machineId },
  );
}

/** 处理机器端 file_changed 单帧（§7.5） */
export function handleFileChangedFrame(entry: FileWsConnectionEntry, msg: Record<string, unknown>): void {
  const machineId = entry.machineId;
  if (!machineId) return;
  const envId = msg.environment_id;
  if (typeof envId !== "string" || envId === "") {
    writeEventWarning(machineId, "invalid_file_changed", { reason: "missing environment_id" });
    return;
  }
  if (!isEnvironmentAccepted(machineId, envId)) return;
  publishMachineFileChanged(machineId, envId, msg.path, msg.kind, msg.source, msg.actor_id, msg.to);
}

/** 处理机器端 file_changed_batch 帧（机器端已合并，服务端逐条再走同一限频器） */
export function handleFileChangedBatchFrame(entry: FileWsConnectionEntry, msg: Record<string, unknown>): void {
  const machineId = entry.machineId;
  if (!machineId) return;
  const envId = msg.environment_id;
  if (typeof envId !== "string" || envId === "") {
    writeEventWarning(machineId, "invalid_file_changed_batch", { reason: "missing environment_id" });
    return;
  }
  if (!isEnvironmentAccepted(machineId, envId)) return;
  const changes = msg.changes;
  if (!Array.isArray(changes)) {
    writeEventWarning(machineId, "invalid_file_changed_batch", {
      environment_id: envId,
      reason: "changes not an array",
    });
    return;
  }
  for (const raw of changes) {
    if (typeof raw !== "object" || raw === null) continue;
    const change = raw as Record<string, unknown>;
    // 逐条校验路径/kind；整帧环境已校验，条目级失败只告警不中断后续条目
    if (typeof change.path !== "string" || change.path === "" || !isChangeKind(change.kind)) {
      writeEventWarning(machineId, "invalid_file_changed_batch_item", {
        environment_id: envId,
        path: typeof change.path === "string" ? change.path : "<non-string>",
      });
      continue;
    }
    publishMachineFileChanged(machineId, envId, change.path, change.kind, change.source, change.actor_id);
  }
}

/** 处理机器端 environment_declared 增量声明帧（跨仓库协议扩展，机器端未实现时记账兜底） */
export function handleEnvironmentDeclaredFrame(entry: FileWsConnectionEntry, msg: Record<string, unknown>): void {
  const machineId = entry.machineId;
  if (!machineId) return;
  const rawEnvs = msg.environments;
  if (!Array.isArray(rawEnvs)) {
    writeEventWarning(machineId, "invalid_environment_declared", { reason: "environments not an array" });
    return;
  }
  const declared = rawEnvs.filter((e): e is string => typeof e === "string" && e !== "");
  if (declared.length > 0 && mergeDeclaredEnvironments(machineId, declared)) {
    strictMachines.add(machineId);
  }
}

/**
 * 广播该机器全部环境的 invalidate_all（§7.3 断连窗口兜底，治理三件套）：
 * 机器级限频 ≤2 条/s（超限合并跳过，订阅方 30s coalescing 兜底收敛）；
 * 每条环境分发加随机抖动 0-5s，防重连风暴。
 * now 参数供测试注入限频窗口时间，生产调用不传。
 */
export function broadcastMachineInvalidateAll(machineId: string, now: number = Date.now()): void {
  const window = machineInvalidateRate.get(machineId);
  if (!window || now - window.start >= 1_000) {
    machineInvalidateRate.set(machineId, { start: now, count: 1 });
  } else if (window.count >= MACHINE_INVALIDATE_LIMIT) {
    return;
  } else {
    window.count++;
  }
  const envs = machineEnvironments.get(machineId);
  if (!envs) return;
  for (const envId of envs) {
    const jitter = Math.floor(Math.random() * INVALIDATE_JITTER_MAX_MS);
    setTimeout(() => publishInvalidateAllLimited(envId), jitter);
  }
}

/**
 * 发布机器 file-ws 能力降级事件（T7："机器在线但文件 503"对订阅方可见）：
 * 记录日志并向该机器权威环境集逐环境发布 degraded（限频 1 条/30s/environment）。
 */
export function publishMachineDegraded(machineId: string, reason: string): void {
  logger.warn(`[file-ws-degraded] machine=${machineId} reason=${reason}`);
  const envs = machineEnvironments.get(machineId);
  if (!envs) return;
  for (const envId of envs) {
    publishDegradedLimited(envId, machineId, "down");
  }
}

/**
 * 清理单机器事件侧状态（僵尸回收 / 机器退役时调用）：连接已终结，环境集与
 * 严格模式标记一并清理防 Map 泄漏；机器若重连会重新声明或经记账重建。
 */
export function clearMachineEventState(machineId: string): void {
  machineEnvironments.delete(machineId);
  strictMachines.delete(machineId);
}

/** 重置全部事件侧状态（优雅关闭 / 测试清理）：服务重启后机器重连重新声明 */
export function resetMachineEventState(): void {
  machineEnvironments.clear();
  strictMachines.clear();
  machineInvalidateRate.clear();
}
