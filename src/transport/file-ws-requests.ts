// file-ws-requests.ts — file_op 请求发送域（§7.2 / §7.3 / §7.6）
//
// 自 file-ws-handler 拆出的请求-响应侧逻辑（保持 handler 单文件 ≤500 行，CLAUDE.md，
// 与 W7 拆出 file-machine-events、W12a 拆出 file-op-retry 的先例一致）。职责边界：
// - 连接登记表（connections / machineFileWsIndex）与帧发送（sendToWs）：handler
//   与本模块共用的连接状态，随请求域迁入——handler 只单向 import 本模块，
//   避免 handler ↔ requests 互相导入成环；
// - pending 登记/清理/背压计数（P0-2）与断连 reject（rejectPendingForWsId /
//   rejectAllPendingRequests）：handler 的 close 路径调用本模块导出函数；
// - file_op 帧发送 + 等待（sendFileOpOnce / sendFileOpAndWait），重试/熔断编排在
//   file-op-retry（W12a）；W7 记账（registerMachineEnvironment）在 file-machine-events；
// - BusyError：背压拒绝错误（P0-2），上层映射 HTTP 429 + Retry-After（W5b）。

import { error as logError } from "@fenix/logger";
import { registerMachineEnvironment } from "../services/file-machine-events";
import type { FileWsConnectionEntry } from "../types/store";
import { runFileOpWithRetry } from "./file-op-retry";
import type { WsConnection } from "./ws-types";

const DEFAULT_FILE_OP_TIMEOUT_MS = 60_000;

// ── P0-2 背压上限（§7.6）：单连接 pending ≤ 64、全局 pending ≤ 1024 ──
const MAX_PENDING_PER_CONNECTION = 64;
const MAX_PENDING_GLOBAL = 1024;

/**
 * 背压拒绝错误（P0-2）。code 恒为 "busy"。
 *
 * 供上层复用：波次 3 W5b 将其映射为 HTTP 429 + Retry-After（瞬时容量问题，
 * 不得映射 503）；波次 6 W12a 据此对 busy 不做自动重试。调用方按
 * `err instanceof BusyError` 或 `err.code === "busy"` 识别，不依赖 message 文本。
 */
export class BusyError extends Error {
  readonly code = "busy";

  constructor(message: string) {
    super(message);
    this.name = "BusyError";
  }
}

// ────────────────────────────────────────────
// Connection maps
// ────────────────────────────────────────────

/** wsId → FileWsConnectionEntry */
export const connections = new Map<string, FileWsConnectionEntry>();

/** machineId → FileWsConnectionEntry (fast lookup by machine) */
export const machineFileWsIndex = new Map<string, FileWsConnectionEntry>();

// ────────────────────────────────────────────
// Pending request tracking (file_op → file_op_result)
// ────────────────────────────────────────────

interface PendingRequest {
  resolve: (result: { status: string; data?: unknown; error?: string }) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Track which wsId this request was sent on, for cleanup on disconnect */
  wsId: string;
}

/** requestId → PendingRequest（handler 的 file_op_result 分支只读查找，配合 removePending） */
export const pendingRequests = new Map<string, PendingRequest>();

/** wsId → 该连接当前 pending 数（P0-2 单连接背压计数，随登记/清理增减） */
const pendingPerWsId = new Map<string, number>();

/** 登记 pending 时递增单连接计数 */
function incrementPendingCount(wsId: string): void {
  pendingPerWsId.set(wsId, (pendingPerWsId.get(wsId) ?? 0) + 1);
}

/** 清理 pending 时递减单连接计数，归零即删除键防 Map 泄漏 */
function decrementPendingCount(wsId: string): void {
  const count = pendingPerWsId.get(wsId);
  if (count === undefined) return;
  if (count <= 1) {
    pendingPerWsId.delete(wsId);
  } else {
    pendingPerWsId.set(wsId, count - 1);
  }
}

/**
 * 统一移除 pending：清定时器 + 从 map 删除 + 递减单连接计数。
 * 所有清理路径（结果返回 / 超时 / 断连 / 替换 / 巡检 / 停机）必须走这里，
 * 否则 pendingPerWsId 计数会漂移，导致背压误判。
 */
export function removePending(requestId: string): PendingRequest | undefined {
  const pending = pendingRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingRequests.delete(requestId);
  decrementPendingCount(pending.wsId);
  return pending;
}

/** reject 指定 wsId 的全部 pending（断连 / 替换 / 巡检共用），逐个 removePending 保证计数一致 */
export function rejectPendingForWsId(wsId: string, err: Error): void {
  for (const [requestId, pending] of pendingRequests) {
    if (pending.wsId !== wsId) continue;
    removePending(requestId);
    pending.reject(err);
  }
}

/**
 * 停机清理（优雅关闭）：reject 全部 pending 并清空背压计数。
 * closeAllFileWsConnections 调用；与 rejectPendingForWsId 共用 removePending，
 * 保证 pendingPerWsId 计数一致（P0-2 背压不漂移）。
 */
export function rejectAllPendingRequests(err: Error): void {
  for (const [requestId] of pendingRequests) {
    const pending = removePending(requestId);
    if (pending) {
      pending.reject(err);
    }
  }
  pendingPerWsId.clear();
}

/** 当前全局 pending 数（handler 停机路径判空用） */
export function pendingRequestCount(): number {
  return pendingRequests.size;
}

let requestIdCounter = 0;

function nextRequestId(): string {
  requestIdCounter++;
  return `freq_${Date.now()}_${requestIdCounter}`;
}

// ────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────

export function sendToWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    ws.send(`${JSON.stringify(msg)}\n`);
  } catch (err) {
    logError("file-ws send error:", err);
  }
}

// ────────────────────────────────────────────
// Request-response API
// ────────────────────────────────────────────

/** file_op 结果（帧解析产物）：status "ok"/"error"，机器端执行错误在 error 字段 */
export interface FileOpResult {
  status: string;
  data?: unknown;
  error?: string;
}

/** sendFileOpAndWait 可选参数（§7.2 / P2-18）：幂等键 + 审计字段，全部可选（向后兼容） */
export interface FileOpOptions {
  /** 领域幂等键：写操作必带、读可省；重试/迁移重发复用同值（机器端 10 分钟内按 (machine, env, op_id) 去重缓存为外部依赖） */
  opId?: string;
  /** 审计字段（P2-18）：发起写操作的用户/调用方标识，帧字段 actor_id */
  actorId?: string;
  /** 审计字段（P2-18）：来源（user/api/agent），帧字段 source */
  source?: string;
}

/**
 * 一次 file_op 发送 + 等待（不做重试/熔断编排；编排在 sendFileOpAndWait 经
 * runFileOpWithRetry 完成）。帧注入 op_id / actor_id / source 仅当 options 提供时
 * 生效——不传 options 时帧与现状完全一致（向后兼容，同波次 W16 现有调用不受影响）。
 */
function sendFileOpOnce(
  machineId: string,
  operation: string,
  params: Record<string, unknown>,
  timeoutMs: number,
  options?: FileOpOptions,
): Promise<FileOpResult> {
  const entry = machineFileWsIndex.get(machineId);
  if (entry?.ws.readyState !== 1) {
    return Promise.reject(new Error(`No active file-ws connection for machine: ${machineId}`));
  }

  // W7 记账（§7.5）：file_op 首次出现某环境时登记 machine→environment 映射，
  // 与 register 声明合并成权威环境集——消除"兜底依赖声明、声明又滞后"的鸡生蛋
  // （旧机器端无声明时，事件放行依赖本记账）。
  const envParam = params.environmentId;
  if (typeof envParam === "string" && envParam !== "") {
    registerMachineEnvironment(machineId, envParam);
  }

  // P0-2 背压（数量侧，§7.6）：单连接 pending ≤ 64、全局 ≤ 1024。
  // 超限同步拒绝（不登记 pending、不启动定时器），错误类型 BusyError 供上层
  // 映射为 HTTP 429 + Retry-After（W5b），防止僵尸机器占满全局 pending 污染健康机器。
  const perConnectionPending = pendingPerWsId.get(entry.wsId) ?? 0;
  if (perConnectionPending >= MAX_PENDING_PER_CONNECTION) {
    return Promise.reject(
      new BusyError(
        `file-op busy: per-connection pending limit (${MAX_PENDING_PER_CONNECTION}) reached for wsId=${entry.wsId}`,
      ),
    );
  }
  if (pendingRequests.size >= MAX_PENDING_GLOBAL) {
    return Promise.reject(new BusyError(`file-op busy: global pending limit (${MAX_PENDING_GLOBAL}) reached`));
  }

  const requestId = nextRequestId();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      removePending(requestId);
      reject(new Error(`file_op timeout: operation=${operation} requestId=${requestId}`));
    }, timeoutMs);

    const pending: PendingRequest = {
      resolve,
      reject,
      timer,
      wsId: entry.wsId,
    };

    pendingRequests.set(requestId, pending);
    incrementPendingCount(entry.wsId);

    const frame: Record<string, unknown> = {
      type: "file_op",
      request_id: requestId,
      operation,
      params,
    };
    // §7.2 幂等键 + P2-18 审计字段：仅 options 提供时注入，不传时帧与现状完全一致
    if (options?.opId) frame.op_id = options.opId;
    if (options?.actorId) frame.actor_id = options.actorId;
    if (options?.source) frame.source = options.source;
    sendToWs(entry.ws, frame);
  });
}

/**
 * 发送文件操作到远程机器并等待结果（§7.2 / §7.3）。
 *
 * options.opId：领域幂等键（写操作必带、读可省），帧 op_id 字段；读操作超时/断连后
 * 自动重试 1 次时复用同值（新 request_id）。options.actorId / options.source：P2-18
 * 审计字段（帧 actor_id / source），由调用方传入并透传。不传 options 时行为与现状
 * 完全一致（向后兼容）。重试矩阵与熔断编排见 file-op-retry。
 */
export function sendFileOpAndWait(
  machineId: string,
  operation: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_FILE_OP_TIMEOUT_MS,
  options?: FileOpOptions,
): Promise<FileOpResult> {
  return runFileOpWithRetry({
    machineId,
    operation,
    attempt: () => sendFileOpOnce(machineId, operation, params, timeoutMs, options),
  });
}
