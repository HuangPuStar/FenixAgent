import type {
  BrowserToolParams,
  PermissionRequestPayload,
  SessionUpdate,
} from "../types.js";
import {
  type JsonRpcMessage,
  isJsonRpcMessage,
  isJsonRpcResponse,
  isJsonRpcNotification,
  isTransportMessage,
  ACP_METHOD,
} from "../json-rpc.js";
import { EventEmitter } from "./emitter.js";

export interface ProtocolEvents {
  status: { connected: boolean; capabilities?: import("../types.js").AgentCapabilities; agentInfo?: { name?: string; version?: string } };
  error: { message: string };
  session_created: { sessionId: string; promptCapabilities?: import("../types.js").PromptCapabilities; models?: import("../types.js").SessionModelState | null; modes?: import("../types.js").SessionModeState | null };
  session_list: { sessions: import("../types.js").AgentSessionInfo[]; nextCursor?: string | null };
  session_loaded: { sessionId: string; promptCapabilities?: import("../types.js").PromptCapabilities; models?: import("../types.js").SessionModelState | null; modes?: import("../types.js").SessionModeState | null };
  session_resumed: { sessionId: string; promptCapabilities?: import("../types.js").PromptCapabilities; models?: import("../types.js").SessionModelState | null; modes?: import("../types.js").SessionModeState | null };
  session_update: { sessionId: string; update: SessionUpdate };
  prompt_complete: { stopReason: string; usage?: import("../types.js").PromptUsage };
  permission_request: PermissionRequestPayload;
  browser_tool_call: { callId: string; params: BrowserToolParams };
  model_changed: { modelId: string };
  mode_changed: { modeId: string };
  pong: undefined;
  rpc_response: { id: number | string; result: unknown };
  [key: string]: unknown;
}

/**
 * ACP 协议解析层。
 *
 * 接收原始字符串 → 解析为传输层消息或 JSON-RPC 消息。
 * 传输层消息（status/error/pong）直接派发。
 * JSON-RPC 响应通过 rpc_response 事件派发（供 ACPPending 匹配）。
 * JSON-RPC 通知映射为具体事件（session_update 等）。
 */
export class ACPProtocol extends EventEmitter<ProtocolEvents> {
  handleMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.error("[ACPProtocol] Failed to parse message:", raw);
      return;
    }

    if ((parsed as Record<string, unknown>)?.type === "keep_alive") return;

    // 传输层消息
    if (isTransportMessage(parsed)) {
      this.handleTransportMessage(parsed as Record<string, unknown>);
      return;
    }

    // JSON-RPC 消息
    if (isJsonRpcMessage(parsed)) {
      this.handleJsonRpcMessage(parsed);
      return;
    }

    console.warn("[ACPProtocol] Unknown message format:", parsed);
  }

  private handleTransportMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case "status":
        this.emit("status", msg.payload as ProtocolEvents["status"]);
        break;
      case "error":
        this.emit("error", msg.payload as ProtocolEvents["error"]);
        break;
      case "pong":
        this.emit("pong");
        break;
    }
  }

  private handleJsonRpcMessage(msg: JsonRpcMessage): void {
    if (isJsonRpcResponse(msg)) {
      if ("result" in msg) {
        this.emit("rpc_response", { id: msg.id, result: msg.result });
      } else if ("error" in msg) {
        this.emit("rpc_response", { id: msg.id as number | string, result: msg });
      }
      return;
    }

    if (isJsonRpcNotification(msg)) {
      this.handleNotification(msg.method, msg.params);
      return;
    }
  }

  private handleNotification(method: string, params: unknown): void {
    const p = params as Record<string, unknown> | undefined;

    switch (method) {
      case ACP_METHOD.SESSION_UPDATE:
        this.emit("session_update", {
          sessionId: p?.sessionId as string,
          update: p?.update as SessionUpdate,
        });
        break;
      case ACP_METHOD.SESSION_MODEL_CHANGED:
        this.emit("model_changed", { modelId: (p as { modelId: string })?.modelId });
        break;
      case ACP_METHOD.SESSION_MODE_CHANGED:
        this.emit("mode_changed", { modeId: (p as { modeId: string })?.modeId });
        break;
      case ACP_METHOD.REQUEST_PERMISSION:
        this.emit("permission_request", params as PermissionRequestPayload);
        break;
      default:
        console.warn("[ACPProtocol] Unknown JSON-RPC notification:", method);
    }
  }
}
