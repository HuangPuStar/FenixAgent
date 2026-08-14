// file-op-retry.ts — 读操作重试矩阵 + 机器级熔断器（docs/arch/12-files.md §7.2 / §7.3）
//
// 自 file-ws-handler 拆出的 W12a 重试/熔断侧逻辑（保持 handler 单文件 ≤500 行，CLAUDE.md，
// 与 W7 拆出 file-machine-events 的先例一致）。职责边界：
// - 读操作重试矩阵：仅 timeout/closed 类失败自动重试 1 次（新 request_id 复用 op_id，
//   与迁移重发共享预算：机器端总执行 ≤2 次）；busy（背压 429）/ 机器端 status:"error" /
//   退役 / 停机 / 无活跃连接均为终态不重试；
// - 写操作不自动重试（§7.3：调用方带 op_id 重发幂等去重）；
// - 机器级熔断器：单机器连续 3 次 timeout/closed（请求级计数）→ 熔断 30s——快速失败 +
//   degraded 事件，防止僵尸机器占满全局 pending 污染健康机器；
// - 成功（含机器端 status:"error" 回执）重置连续失败计数（机器活着，响应正常）。
//
// 错误分类基于 handler 各 reject 路径的 Error.message 前缀 + code 属性
// （BusyError / CircuitOpenError），集中在本模块 isRetryableFileOpFailure——
// 新增 handler reject 路径时必须同步本函数。

import { createLogger } from "@fenix/logger";
import { publishMachineDegraded } from "../services/file-machine-events";
import type { FileOpResult } from "./file-ws-requests";

const logger = createLogger("file-op-retry");

/** 熔断失败阈值：单机器连续 N 次 timeout/closed 触发熔断（§7.2） */
const CIRCUIT_FAILURE_THRESHOLD = 3;
/** 熔断持续时间：30s 内快速失败（上层兜底映射 503），到期自动关闭允许下一次请求试探 */
const CIRCUIT_OPEN_MS = 30_000;

/** 写操作集合（§7.2）：机器端按 op_id 缓存结果；这些操作超时/断连不做自动重试 */
const WRITE_OPERATIONS = new Set(["write", "mkdir", "delete", "rename", "upload"]);

/**
 * 熔断打开期间的快速失败错误。code 恒为 "circuit_open"。
 *
 * 上层（agent-file-service.mapFileError）未识别时兜底映射 503 file_service_unavailable，
 * 与 §7.2"熔断快速失败返回 503"契约一致；调用方按 `err.code === "circuit_open"` 识别，
 * 不依赖 message 文本。
 */
export class CircuitOpenError extends Error {
  readonly code = "circuit_open";

  constructor(message: string) {
    super(message);
    this.name = "CircuitOpenError";
  }
}

interface CircuitState {
  /** 连续 timeout/closed 失败数（请求级：一次请求含重试只计 1 次） */
  consecutiveFailures: number;
  /** 熔断到期时间戳；0 = 未熔断 */
  openUntil: number;
}

/** 机器级熔断状态表（key：machineId）；优雅关闭时由 handler 经 resetFileOpCircuitStates 清理 */
const circuitStates = new Map<string, CircuitState>();

// 熔断时钟：测试注入等价于把熔断时间拨快/拨慢（与 sweepFileWsConnections 的 now
// 注入同模式），生产恒为 Date.now
let circuitClock: () => number = Date.now;

/** 测试注入熔断时钟；生产代码不得调用 */
export function setFileOpCircuitClock(fn: () => number): void {
  circuitClock = fn;
}

/** 恢复真实时钟（测试收尾） */
export function resetFileOpCircuitClock(): void {
  circuitClock = Date.now;
}

/** 查询机器熔断状态（测试断言熔断打开/关闭）；未记录返回 undefined */
export function getFileOpCircuitState(machineId: string): CircuitState | undefined {
  return circuitStates.get(machineId);
}

/** 清理全部熔断状态（测试隔离 / 服务优雅关闭时调用） */
export function resetFileOpCircuitStates(): void {
  circuitStates.clear();
}

/** 判定操作是否为写操作（§7.2 重试矩阵分界：写操作不自动重试） */
export function isWriteOperation(operation: string): boolean {
  return WRITE_OPERATIONS.has(operation);
}

/**
 * 判定失败是否可自动重试（§7.2 读重试矩阵）。
 *
 * 可恢复（timeout/closed 类）：机器可能正在重连，读操作重发一次有收敛价值
 * （§7.3 迁移语义——旧连接 pending 在新连接上以新 request_id 重发，复用原 op_id）。
 * 终态不重试：busy（背压 429，重试必然再次 busy）/ 熔断 / 机器退役 / 服务停机 /
 * 无活跃连接（重试必然同样失败）。新增 handler reject 路径时必须同步本函数。
 */
export function isRetryableFileOpFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = "code" in err ? err.code : undefined;
  if (code === "busy" || code === "circuit_open") return false;
  const msg = err.message;
  return (
    msg.startsWith("file_op timeout") ||
    msg.startsWith("Connection closed") ||
    msg.startsWith("aborted") ||
    msg.includes("zombie connection")
  );
}

/** 查询机器当前是否处于熔断期；到期自动关闭并清除状态（允许下一次请求试探） */
export function isMachineCircuitOpen(machineId: string): boolean {
  const state = circuitStates.get(machineId);
  if (!state || state.openUntil === 0) return false;
  if (circuitClock() >= state.openUntil) {
    circuitStates.delete(machineId);
    return false;
  }
  return true;
}

/**
 * 记录一次机器级失败（请求最终失败且属于 timeout/closed 类）。
 * 连续达到阈值 → 打开熔断（30s）+ 发布 degraded 事件（T7 能力降级对订阅方可见，
 * 消费端据此展示"文件服务暂不可用"而非空目录）。熔断期内不再累计
 * （快速失败不消耗计数，到期自动关闭后重新积累）。
 */
export function recordFileOpFailure(machineId: string): void {
  const now = circuitClock();
  const state = circuitStates.get(machineId) ?? { consecutiveFailures: 0, openUntil: 0 };
  if (state.openUntil > now) return;
  state.consecutiveFailures += 1;
  if (state.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
    state.openUntil = now + CIRCUIT_OPEN_MS;
    state.consecutiveFailures = 0;
    publishMachineDegraded(machineId, `circuit open: ${CIRCUIT_FAILURE_THRESHOLD} consecutive timeout/closed failures`);
    logger.warn(`[file-op-circuit] machine=${machineId} circuit open for ${CIRCUIT_OPEN_MS}ms`);
  }
  circuitStates.set(machineId, state);
}

/** 记录一次成功（含机器端 status:"error" 回执）：机器活着、响应正常，重置连续失败计数 */
export function recordFileOpSuccess(machineId: string): void {
  circuitStates.delete(machineId);
}

/**
 * 执行一次 file_op 并应用读重试矩阵与机器级熔断（§7.2 / §7.3）。
 *
 * 执行顺序：熔断快速失败 → attempt（发送 + 等待）→ 可恢复失败且非写操作时重试 1 次
 * （新 request_id 复用 op_id，总执行 ≤2 次）→ 最终失败记入熔断计数 / 成功重置计数。
 * attempt 由调用方提供（handler 闭包持有连接索引与 pending 登记），本函数不依赖
 * 传输细节，便于独立演进与测试。
 */
export function runFileOpWithRetry(opts: {
  machineId: string;
  operation: string;
  attempt: () => Promise<FileOpResult>;
}): Promise<FileOpResult> {
  if (isMachineCircuitOpen(opts.machineId)) {
    return Promise.reject(new CircuitOpenError(`file-op circuit open for machine: ${opts.machineId}`));
  }
  return opts
    .attempt()
    .catch((err) => {
      // 写操作不自动重试（§7.3：调用方带 op_id 重发幂等去重）；busy / 熔断 / 退役 /
      // 停机 / 无活跃连接为终态
      if (isWriteOperation(opts.operation) || !isRetryableFileOpFailure(err)) throw err;
      return opts.attempt();
    })
    .then(
      (result) => {
        recordFileOpSuccess(opts.machineId);
        return result;
      },
      (err) => {
        if (isRetryableFileOpFailure(err)) recordFileOpFailure(opts.machineId);
        throw err;
      },
    );
}
