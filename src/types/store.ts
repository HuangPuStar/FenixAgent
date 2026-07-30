/**
 * store.ts — In-memory store entry type definitions.
 *
 * All inline interfaces scattered across transport handlers and services
 * should reference these types instead of defining their own.
 */

import type { RemoteTransport } from "@fenix/remote-runtime";
import type { WsConnection } from "../transport/ws-types";

// ────────────────────────────────────────────
// ACP WebSocket Connection
// Extracted from: src/transport/acp-ws-handler.ts
// ────────────────────────────────────────────

/** Per-connection state for ACP WebSocket connections (`/acp/ws`) */
export interface AcpConnectionEntry {
  agentId: string | null;
  boundEnvId: string | null;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  lastClientActivity: number;
  capabilities: Record<string, unknown> | null;
  /** 标记此连接为 machine 注册连接（非 ACP agent 连接） */
  isMachine: boolean;
  /** machine 注册成功后分配的 ID（mach_xxx），注册完成前为 null */
  machineId: string | null;
  /** 连接自身的 wsId（与 connections Map 的 key 一致），方便 entry 反查自身 */
  wsId: string;
  /** relay 层注册的 per-session 消息回调 */
  sessionMessageListeners?: Map<string, (sessionId: string, type: string, payload: unknown) => void>;
  /** relay 层设置的回调，machine 连接收到 session 消息时调用 */
  onSessionMessage?: (sessionId: string, type: string, payload: unknown) => void;
  /** 远程 transport 实例（由 registerRemoteNode 设置），用于将消息路由到 core remote-runtime */
  remoteTransport?: RemoteTransport;
}

// ────────────────────────────────────────────
// WS Session Cleanup
// Extracted from: src/transport/ws-handler.ts
// ────────────────────────────────────────────

/** Per-session cleanup state for legacy bridge WebSocket connections */
export interface WsSessionCleanupEntry {
  unsub: () => void;
  keepalive: ReturnType<typeof setInterval>;
  ws: WsConnection;
  openTime: number;
  lastClientActivity: number;
}

// ────────────────────────────────────────────
// Instance Supplement
// Extracted from: src/services/instance.ts
// ────────────────────────────────────────────

/** 实例启动来源，用于并发分类与后续审计。 */
export type InstanceSpawnSource = "interactive" | "scheduled" | "system";

/** RCS business fields not tracked by core RuntimeInstanceSnapshot */
export interface InstanceSupplement {
  userId: string;
  environmentId: string;
  instanceNumber: number;
  organizationId: string;
  /** 实例创建来源，用于并发分类与审计。 */
  spawnSource: InstanceSpawnSource;
  /** 最近一次非保活 ACP 业务消息时间 */
  lastActivityAt: number;
  /** 当前绑定到该实例的前端 relay 连接数 */
  relayCount: number;
  /** 最后一次 relay 全部断开、实例进入空闲观察窗口的时间 */
  lastRelayDetachedAt: number | null;
}

// ────────────────────────────────────────────
// Scheduler Job
// Extracted from: src/services/scheduler.ts
// ────────────────────────────────────────────

/** Active scheduled job entry */
export interface ScheduledJobEntry {
  taskId: string;
  job: import("node-schedule").Job;
}

// ────────────────────────────────────────────
// Rate Limit
// Extracted from: src/plugins/rate-limit.ts
// ────────────────────────────────────────────

/** Per-IP rate limit sliding window entry */
export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// ────────────────────────────────────────────
// File WS Connection
// 用于 /acp/file-ws 端点的远程文件操作连接
// ────────────────────────────────────────────

/** Per-connection state for file operation WebSocket connections (`/acp/file-ws`) */
export interface FileWsConnectionEntry {
  /** 关联的 machine ID（注册后赋值） */
  machineId: string | null;
  /** WS 连接 */
  ws: import("../transport/ws-types").WsConnection;
  /** 连接 ID */
  wsId: string;
  /** 连接打开时间 */
  openTime: number;
  /** 最后活跃时间（用于超时检测） */
  lastClientActivity: number;
}
