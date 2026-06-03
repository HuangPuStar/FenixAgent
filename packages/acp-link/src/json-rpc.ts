// packages/acp-link/src/json-rpc.ts

// ── JSON-RPC 2.0 核心类型 ──────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcSuccessResponse {
  jsonrpc: "2.0";
  id: number | string;
  result: unknown;
}

export interface JsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  error: { code: number; message: string; data?: unknown };
}

export type JsonRpcResponse = JsonRpcSuccessResponse | JsonRpcErrorResponse;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// ── ACP 方法名常量 ──────────────────────────

export const ACP_METHOD = {
  SESSION_NEW: "session/new",
  SESSION_LOAD: "session/load",
  SESSION_RESUME: "session/resume",
  SESSION_LIST: "session/list",
  SESSION_PROMPT: "session/prompt",
  SESSION_CANCEL: "session/cancel",
  SESSION_SET_MODEL: "session/setModel",
  SESSION_SET_MODE: "session/setMode",
  SESSION_UPDATE: "session/update",
  SESSION_MODEL_CHANGED: "session/modelChanged",
  SESSION_MODE_CHANGED: "session/modeChanged",
  REQUEST_PERMISSION: "requestPermission",
} as const;

// 传输层消息类型（非 JSON-RPC）
export const TRANSPORT_TYPES = ["connect", "disconnect", "status", "error", "ping", "pong", "keep_alive"] as const;

// ── 工具函数 ──────────────────────────

let _nextId = 0;

export function nextRpcId(): number {
  _nextId += 1;
  return _nextId;
}

export function createRequest(method: string, params?: unknown): JsonRpcRequest {
  return { jsonrpc: "2.0", id: nextRpcId(), method, params: params ?? {} };
}

export function createNotification(method: string, params?: unknown): JsonRpcNotification {
  return { jsonrpc: "2.0", method, params };
}

export function createSuccessResponse(id: number | string, result: unknown): JsonRpcSuccessResponse {
  return { jsonrpc: "2.0", id, result };
}

export function createErrorResponse(id: number | string | null, code: number, message: string): JsonRpcErrorResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

export function isJsonRpcMessage(msg: unknown): msg is JsonRpcMessage {
  return typeof msg === "object" && msg !== null && (msg as Record<string, unknown>).jsonrpc === "2.0";
}

export function isJsonRpcRequest(msg: JsonRpcMessage): msg is JsonRpcRequest {
  return "method" in msg && "id" in msg;
}

export function isJsonRpcNotification(msg: JsonRpcMessage): msg is JsonRpcNotification {
  return "method" in msg && !("id" in msg);
}

export function isJsonRpcResponse(msg: JsonRpcMessage): msg is JsonRpcResponse {
  return "id" in msg && ("result" in msg || "error" in msg);
}

export function isTransportMessage(msg: unknown): boolean {
  if (typeof msg !== "object" || msg === null) return false;
  const type = (msg as Record<string, unknown>).type;
  return typeof type === "string" && (TRANSPORT_TYPES as readonly string[]).includes(type);
}
