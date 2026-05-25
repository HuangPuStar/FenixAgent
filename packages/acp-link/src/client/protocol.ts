import type {
  BrowserToolParams,
  PermissionRequestPayload,
  ProxyErrorMessage,
  ProxyPromptCompleteMessage,
  ProxyResponse,
  ProxySessionCreatedMessage,
  ProxySessionListMessage,
  ProxySessionLoadedMessage,
  ProxySessionResumedMessage,
  ProxyStatusMessage,
  SessionUpdate,
} from "../types.js";
import { EventEmitter } from "./emitter.js";

export interface ProtocolEvents {
  status: ProxyStatusMessage["payload"];
  error: ProxyErrorMessage["payload"];
  session_created: ProxySessionCreatedMessage["payload"];
  session_list: ProxySessionListMessage["payload"];
  session_loaded: ProxySessionLoadedMessage["payload"];
  session_resumed: ProxySessionResumedMessage["payload"];
  session_update: { sessionId: string; update: SessionUpdate };
  prompt_complete: ProxyPromptCompleteMessage["payload"];
  permission_request: PermissionRequestPayload;
  browser_tool_call: { callId: string; params: BrowserToolParams };
  model_changed: { modelId: string };
  mode_changed: { modeId: string };
  pong: undefined;
  [key: string]: unknown;
}

/**
 * 无状态的 ACP 协议解析层。
 *
 * 职责：
 * - 接收原始字符串 → JSON.parse → 类型化为 ProxyResponse
 * - 过滤非业务消息（keep_alive）
 * - 派发类型化事件给上层
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

    // 过滤非业务消息
    if ((parsed as Record<string, unknown>)?.type === "keep_alive") return;

    const response = parsed as ProxyResponse;

    switch (response.type) {
      case "status":
        this.emit("status", response.payload);
        break;
      case "error":
        this.emit("error", response.payload);
        break;
      case "session_created":
        this.emit("session_created", response.payload);
        break;
      case "session_list":
        this.emit("session_list", response.payload);
        break;
      case "session_loaded":
        this.emit("session_loaded", response.payload);
        break;
      case "session_resumed":
        this.emit("session_resumed", response.payload);
        break;
      case "session_update":
        this.emit("session_update", {
          sessionId: response.payload.sessionId,
          update: response.payload.update,
        });
        break;
      case "prompt_complete":
        this.emit("prompt_complete", response.payload);
        break;
      case "permission_request":
        this.emit("permission_request", response.payload);
        break;
      case "browser_tool_call":
        this.emit("browser_tool_call", {
          callId: response.callId,
          params: response.params,
        });
        break;
      case "model_changed":
        this.emit("model_changed", response.payload);
        break;
      case "mode_changed":
        this.emit("mode_changed", response.payload);
        break;
      case "pong":
        this.emit("pong");
        break;
      default:
        console.warn("[ACPProtocol] Unknown message type:", (response as Record<string, unknown>).type);
    }
  }
}
