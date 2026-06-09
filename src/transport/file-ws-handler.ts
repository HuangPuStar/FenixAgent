import { createLogger, error as logError } from "@fenix/logger";
import type { FileWsConnectionEntry } from "../types/store";
import type { WsConnection } from "./ws-types";

const logger = createLogger("transport-file-ws-handler");

const DEFAULT_FILE_OP_TIMEOUT_MS = 60_000;

// ────────────────────────────────────────────
// Connection maps
// ────────────────────────────────────────────

/** wsId → FileWsConnectionEntry */
const connections = new Map<string, FileWsConnectionEntry>();

/** machineId → FileWsConnectionEntry (fast lookup by machine) */
const machineFileWsIndex = new Map<string, FileWsConnectionEntry>();

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

/** requestId → PendingRequest */
const pendingRequests = new Map<string, PendingRequest>();

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

  // Close old connection if this machine already has a file-ws
  const existing = machineFileWsIndex.get(machineId);
  if (existing && existing.wsId !== wsId) {
    logger.debug(`file-ws replacing old connection: machineId=${machineId} oldWsId=${existing.wsId}`);
    try {
      existing.ws.close(1000, "replaced by new connection");
    } catch {
      // ignore
    }
    connections.delete(existing.wsId);
  }

  entry.machineId = machineId;
  machineFileWsIndex.set(machineId, entry);
  logger.debug(`file-ws registered: machineId=${machineId} wsId=${wsId}`);
  sendToWs(entry.ws, { type: "registered" });
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

    if (type === "file_op_result") {
      const requestId = msg.request_id as string | undefined;
      if (!requestId) {
        logError("file-ws file_op_result missing request_id");
        continue;
      }
      const pending = pendingRequests.get(requestId);
      if (!pending) {
        logError(`file-ws file_op_result unknown request_id: ${requestId}`);
        continue;
      }
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
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
  for (const [_requestId, pending] of pendingRequests) {
    if (pending.wsId === wsId) {
      clearTimeout(pending.timer);
      pendingRequests.delete(_requestId);
      pending.reject(new Error(`Connection closed (wsId=${wsId})`));
    }
  }

  connections.delete(wsId);
}

// ────────────────────────────────────────────
// Request-response API
// ────────────────────────────────────────────

/** Send a file operation to the remote machine and wait for the result */
export function sendFileOpAndWait(
  machineId: string,
  operation: string,
  params: Record<string, unknown>,
  timeoutMs: number = DEFAULT_FILE_OP_TIMEOUT_MS,
): Promise<{ status: string; data?: unknown; error?: string }> {
  const entry = machineFileWsIndex.get(machineId);
  if (!entry || entry.ws.readyState !== 1) {
    return Promise.reject(new Error(`No active file-ws connection for machine: ${machineId}`));
  }

  const requestId = nextRequestId();

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`file_op timeout: operation=${operation} requestId=${requestId}`));
    }, timeoutMs);

    const pending: PendingRequest = {
      resolve,
      reject,
      timer,
      wsId: entry.wsId,
    };

    pendingRequests.set(requestId, pending);

    sendToWs(entry.ws, {
      type: "file_op",
      request_id: requestId,
      operation,
      params,
    });
  });
}

/** Check if a machine has an active file-ws connection */
export function isFileWsConnected(machineId: string): boolean {
  const entry = machineFileWsIndex.get(machineId);
  return !!entry && entry.ws.readyState === 1;
}

/** Graceful shutdown — close all file-ws connections and reject pending requests */
export function closeAllFileWsConnections(): void {
  if (connections.size === 0 && pendingRequests.size === 0) return;

  logger.debug(
    `file-ws graceful shutdown: ${connections.size} connection(s), ${pendingRequests.size} pending request(s)`,
  );

  // Reject all pending requests
  for (const [_requestId, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("server shutdown"));
  }
  pendingRequests.clear();

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
  logger.debug("file-ws all connections closed");
}
