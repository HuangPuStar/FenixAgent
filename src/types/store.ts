/**
 * store.ts — In-memory store entry type definitions.
 *
 * All inline interfaces scattered across transport handlers and services
 * should reference these types instead of defining their own.
 */

import type { EngineRelayHandle } from "@mothership/plugin-sdk";
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
}

// ────────────────────────────────────────────
// Relay Connection
// Extracted from: src/transport/relay/connection-manager.ts
// ────────────────────────────────────────────

/** Per-connection state for frontend relay connections (`/acp/relay/:agentId`) */
export interface RelayConnectionEntry {
  agentId: string;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  instanceId: string | null;
  relayHandle: EngineRelayHandle | null;
  relayUnsub: (() => void) | null;
  outboundBuffer: Record<string, unknown>[];
}

/** RelayConnectionEntry + wsId for managed connections */
export interface ManagedConnection extends RelayConnectionEntry {
  wsId: string;
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

/** RCS business fields not tracked by core RuntimeInstanceSnapshot */
export interface InstanceSupplement {
  userId: string;
  environmentId: string;
  instanceNumber: number;
  organizationId: string;
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
// Session Worker
// Extracted from: src/repositories/session-worker.ts
// ────────────────────────────────────────────

/** Worker status values reported by ACP agent */
export type WorkerStatus = "idle" | "running" | "requires_action" | "completed" | "error";

/** Shape of a pending permission request from ACP agent */
export interface PermissionRequestDetails {
  toolName?: string;
  input?: Record<string, unknown>;
  requestId?: string;
}
