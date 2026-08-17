// file-ws-handler.ts — file-ws 连接生命周期与消息路由（P0-1/P0-3/P0-5，W7）
//
// 连接侧薄壳：open/register/message/close/sweep/shutdown 的登记表维护与帧路由。
// 模块拆分（保持单文件 ≤500 行，CLAUDE.md）：请求发送域（pending 管理、
// sendFileOpAndWait、BusyError）已拆至 file-ws-requests.ts——连接登记表
// （connections / machineFileWsIndex）与帧发送（sendToWs）随请求域迁入，
// 本文件单向 import 复用（避免 handler ↔ requests 互相导入成环）；
// W7 事件接收在 file-machine-events，W12a 重试/熔断在 file-op-retry。

import { createLogger, error as logError } from "@fenix/logger";
import {
  broadcastMachineInvalidateAll,
  clearMachineEventState,
  handleEnvironmentDeclaredFrame,
  handleFileChangedBatchFrame,
  handleFileChangedFrame,
  handleFileWsRegisterIdentity,
  publishMachineDegraded,
  registerMachineDeclaration,
  resetMachineEventState,
} from "../services/file-machine-events";
import { resetFileOpCircuitStates } from "./file-op-retry";
import {
  connections,
  machineFileWsIndex,
  pendingRequestCount,
  pendingRequests,
  rejectAllPendingRequests,
  rejectPendingForWsId,
  removePending,
  sendToWs,
} from "./file-ws-requests";
import type { WsConnection } from "./ws-types";

const logger = createLogger("transport-file-ws-handler");

// ── P0-1 心跳巡检默认值（§7.4）：keep_alive 间隔 ≤30s 为跨仓库软契约，
// 3 倍间隔（90s）判定僵尸；巡检间隔 30s。默认值与 env.ts 保持一致。──
const DEFAULT_FILE_WS_IDLE_TIMEOUT_MS = 90_000;
const DEFAULT_FILE_WS_SWEEP_INTERVAL_MS = 30_000;

// ────────────────────────────────────────────
// Connection lifecycle
// ────────────────────────────────────────────

/** Called on WS open — creates tracking entry */
export function handleFileWsOpen(ws: WsConnection, wsId: string): void {
  logger.debug(`file-ws connection opened: wsId=${wsId}`);
  connections.set(wsId, {
    machineId: null,
    ws,
    wsId,
    openTime: Date.now(),
    lastClientActivity: Date.now(),
  });
}

/** Handles `register` message — binds machineId to this connection */
export function handleFileWsRegister(wsId: string, msg: Record<string, unknown>): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const machineId = msg.machine_id as string | undefined;
  if (!machineId) {
    logError(`file-ws register missing machine_id: wsId=${wsId}`);
    sendToWs(entry.ws, { type: "error", message: "missing machine_id" });
    return;
  }

  // W11 身份绑定（§7.1）：对账 core runtime node；严格模式未知 machine → close 4404（宽松放行 + 告警）
  if (handleFileWsRegisterIdentity(entry, machineId)) return;
  // Close old connection if this machine already has a file-ws
  const existing = machineFileWsIndex.get(machineId);
  if (existing && existing.wsId !== wsId) {
    logger.debug(`file-ws replacing old connection: machineId=${machineId} oldWsId=${existing.wsId}`);
    // P0-3（D3 前置修复）：必须先 reject 旧连接全部 pending 再删登记 + close。
    // 现状先 connections.delete 再 close，handleFileWsClose 因 entry 不存在而早退
    // （file-ws-handler.ts:161-163），旧连接 pending 悬挂至 60s/120s 超时。
    // aborted 为替换语义错误，上层据此区分"被新连接顶替"而非机器端执行失败。
    rejectPendingForWsId(existing.wsId, new Error("aborted"));
    connections.delete(existing.wsId);
    try {
      existing.ws.close(1000, "replaced by new connection");
    } catch {
      // 连接已处于异常状态时 close 抛错；登记与索引清理已完成，不影响替换
    }
  }

  entry.machineId = machineId;
  machineFileWsIndex.set(machineId, entry);

  // W7 环境声明（§7.5）：≤500 超限拒绝 + registryEvent；旧机器端无 environments
  // → 宽松模式放行 + 告警日志。事件接收/记账/广播逻辑收敛在 file-machine-events。
  registerMachineDeclaration(machineId, msg.environments);

  logger.debug(`file-ws registered: machineId=${machineId} wsId=${wsId}`);
  sendToWs(entry.ws, { type: "registered" });

  // W7 invalidate_all 治理（§7.3 断连窗口兜底）：register 成功后广播该机器
  // 全部环境的 invalidate_all（机器级限频 + 分发抖动），订阅方据此重拉收敛，
  // 断连窗口内丢失的 file_changed 无需重放。
  broadcastMachineInvalidateAll(machineId);
}

/** Routes incoming NDJSON messages */
export function handleFileWsMessage(_ws: WsConnection, wsId: string, data: string | Record<string, unknown>): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  entry.lastClientActivity = Date.now();

  // Normalize to array of parsed messages
  const messages: Record<string, unknown>[] = [];
  if (typeof data === "string") {
    for (const line of data.split("\n").filter((l) => l.trim())) {
      try {
        messages.push(JSON.parse(line));
      } catch {
        logError("file-ws parse error:", line);
      }
    }
  } else {
    messages.push(data);
  }

  for (const msg of messages) {
    const type = msg.type as string;

    if (type === "keep_alive") {
      // silently update activity (already done above)
      continue;
    }

    if (type === "register") {
      handleFileWsRegister(wsId, msg);
      continue;
    }

    // W7 事件帧（§7.5）：接收校验与发布逻辑在 file-machine-events
    if (type === "file_changed") {
      handleFileChangedFrame(entry, msg);
      continue;
    }

    if (type === "file_changed_batch") {
      handleFileChangedBatchFrame(entry, msg);
      continue;
    }

    if (type === "environment_declared") {
      handleEnvironmentDeclaredFrame(entry, msg);
      continue;
    }

    if (type === "file_op_result") {
      const requestId = msg.request_id as string | undefined;
      if (!requestId) {
        logError("file-ws file_op_result missing request_id");
        continue;
      }
      // pending 登记/清理在 file-ws-requests（sendFileOpAndWait 侧），此处只查找与回执
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        logError(`file-ws file_op_result unknown request_id: ${requestId}`);
        continue;
      }
      removePending(requestId);
      pending.resolve({
        status: (msg.status as string) ?? "ok",
        data: msg.data,
        error: msg.error as string | undefined,
      });
      continue;
    }

    // Unknown message type — ignore
    logger.debug(`file-ws unknown message type: ${type}`);
  }
}

/**
 * 退役机器的 file-ws 立即切断（P0-5，D18）。
 *
 * 由 `registry.deleteMachine` 在 DB 记录删除后调用：reject 该机器全部 pending、
 * 从 machineFileWsIndex / connections 删除登记并 close 连接，与 sweep / 替换的
 * 清理顺序一致（先 reject pending 再删登记 + close），避免 close 回调
 * （handleFileWsClose）因 entry 已删除而早退导致 pending 悬挂。
 * 机器没有活跃 file-ws 连接时为空操作。
 */
export function closeMachineFileWsConnection(machineId: string): void {
  const entry = machineFileWsIndex.get(machineId);
  if (!entry) return;

  rejectPendingForWsId(entry.wsId, new Error(`machine retired: ${machineId}`));
  machineFileWsIndex.delete(machineId);
  connections.delete(entry.wsId);
  // W7：机器退役为永久性终结，清理事件侧状态（环境集 / 严格模式，防 Map 泄漏）
  clearMachineEventState(machineId);
  try {
    entry.ws.close(1000, "machine retired");
  } catch {
    // 连接已处于异常状态时 close 抛错；登记与 pending 清理已完成，不影响退役
  }
}

/** Called on WS close — cleanup maps and reject pending requests */
export function handleFileWsClose(_ws: WsConnection, wsId: string): void {
  const entry = connections.get(wsId);
  if (!entry) return;

  const duration = Math.round((Date.now() - entry.openTime) / 1000);
  logger.debug(`file-ws connection closed: wsId=${wsId} machineId=${entry.machineId ?? "null"} duration=${duration}s`);

  // Remove from machine index
  if (entry.machineId) {
    const indexed = machineFileWsIndex.get(entry.machineId);
    if (indexed?.wsId === wsId) {
      machineFileWsIndex.delete(entry.machineId);
    }
  }

  // Reject all pending requests associated with this connection
  rejectPendingForWsId(wsId, new Error(`Connection closed (wsId=${wsId})`));

  connections.delete(wsId);
}

// ────────────────────────────────────────────
// Request-response API（发送域在 file-ws-requests；此处仅连接查询与停机清理）
// ────────────────────────────────────────────

/** Check if a machine has an active file-ws connection */
export function isFileWsConnected(machineId: string): boolean {
  const entry = machineFileWsIndex.get(machineId);
  return !!entry && entry.ws.readyState === 1;
}

/** Graceful shutdown — close all file-ws connections and reject pending requests */
export function closeAllFileWsConnections(): void {
  if (connections.size === 0 && pendingRequestCount() === 0) {
    resetMachineEventState();
    return;
  }

  logger.debug(
    `file-ws graceful shutdown: ${connections.size} connection(s), ${pendingRequestCount()} pending request(s)`,
  );

  // Reject all pending requests (pending 登记/清理在 file-ws-requests)
  rejectAllPendingRequests(new Error("server shutdown"));

  // Close all connections
  for (const [_wsId, entry] of connections) {
    try {
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, "server_shutdown");
      }
    } catch {
      // ignore errors during shutdown
    }
  }

  connections.clear();
  machineFileWsIndex.clear();
  // W7：优雅关闭重置事件侧状态，服务重启后机器重连重新声明，避免陈旧状态残留
  resetMachineEventState();
  // W12a：熔断状态同样不得跨进程生命周期残留（服务重启后机器重连重新积累）
  resetFileOpCircuitStates();
  logger.debug("file-ws all connections closed");
}

// ────────────────────────────────────────────
// P0-1 心跳巡检（独立于 startMachineSweep）
// ────────────────────────────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * file-ws degraded 事件发布钩子（P0-1 预留出口；W7 接入事件通道）。
 * 记录日志并向该机器权威环境集逐环境发布 degraded 事件（限频 1 条/30s/environment），
 * 使"机器在线但文件 503"（T7 能力降级）对订阅方可见。
 */
export function publishFileWsDegraded(machineId: string, reason: string): void {
  publishMachineDegraded(machineId, reason);
}

/**
 * 巡检一次 machineFileWsIndex：将 lastClientActivity 距今超过 idleTimeoutMs 的连接
 * 判为僵尸 → reject 全部 pending + 清索引 + close + 发布 degraded。
 *
 * now 参数供测试注入未来时间（等价于把连接活跃时间拨老），生产调用不传。
 * 清理顺序与 P0-3 一致：先 reject pending 再删登记 + close，避免 close 回调
 * （handleFileWsClose）因 entry 已删除而早退导致 pending 悬挂。
 */
export function sweepFileWsConnections(idleTimeoutMs: number, now: number = Date.now()): void {
  for (const [machineId, entry] of machineFileWsIndex) {
    if (entry.ws.readyState !== 1) continue;
    const idleMs = now - entry.lastClientActivity;
    if (idleMs <= idleTimeoutMs) continue;

    rejectPendingForWsId(entry.wsId, new Error(`file-ws zombie connection: machine=${machineId} wsId=${entry.wsId}`));
    machineFileWsIndex.delete(machineId);
    connections.delete(entry.wsId);
    try {
      entry.ws.close(1008, "idle timeout");
    } catch {
      // 关闭失败不阻断清理：索引与 pending 已处理完毕
    }
    publishFileWsDegraded(machineId, `idle timeout (${Math.round(idleMs / 1000)}s no activity)`);
    // W7：僵尸机器视为生命周期终结，清理其事件侧状态（环境集 / 严格模式），
    // 防 Map 泄漏；机器若重连会重新 register（声明或记账）重建权威集。
    clearMachineEventState(machineId);
    logger.warn(`[file-ws-sweep] zombie connection reaped: machine=${machineId} wsId=${entry.wsId} idleMs=${idleMs}`);
  }
}

/**
 * 启动 file-ws 僵尸连接巡检（P0-1，§7.4）。
 * 必须独立于 startMachineSweep：后者只查 DB 中 status=online 的机器
 * （registry-heartbeat.ts），覆盖不到 file-ws 的 half-open 僵尸连接。
 * 灰度开关（config.fileWsSweepEnabled）由调用方控制：旧机器端未实现 keep_alive
 * 或间隔 >90s 时会被误判僵尸，默认关闭逐步开启。
 */
export function startFileWsSweep(
  intervalMs: number = DEFAULT_FILE_WS_SWEEP_INTERVAL_MS,
  idleTimeoutMs: number = DEFAULT_FILE_WS_IDLE_TIMEOUT_MS,
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepFileWsConnections(idleTimeoutMs);
    } catch (err) {
      logger.error("file-ws sweep error", err instanceof Error ? err : undefined);
    }
  }, intervalMs);
}

/** 停止 file-ws 僵尸巡检（优雅关闭时先于 closeAllFileWsConnections 调用） */
export function stopFileWsSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
