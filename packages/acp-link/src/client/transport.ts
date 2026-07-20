import { io, type Socket } from "socket.io-client";
import { EventEmitter } from "./emitter.js";

export type TransportState = "connecting" | "connected" | "disconnected" | "error";

export interface TransportEvents {
  state: { state: TransportState; detail?: CloseEvent };
  message: string;
  reconnecting: { attempt: number; maxAttempts: number };
  reconnectFailed: undefined;
  [key: string]: unknown;
}

/**
 * 基于 socket.io-client 的传输层，不知道 ACP 协议。
 *
 * 职责：
 * - 连接/断开 socket.io namespace
 * - 利用 socket.io 内置自动重连、心跳
 * - 收发原始字符串
 * - 传播连接状态和重连信息
 */
export class SocketIOTransport extends EventEmitter<TransportEvents> {
  private socket: Socket | null = null;
  private _state: TransportState = "disconnected";
  private namespace = "";
  private query: Record<string, string> = {};

  private lastError: string | undefined;

  get state(): TransportState {
    return this._state;
  }

  connect(namespace: string, query?: Record<string, string>): void {
    this.disconnect();
    this.namespace = namespace;
    this.query = query ?? {};
    this.setState("connecting");

    const socket = io(this.namespace, {
      query: this.query,
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      timeout: 30000,
    });

    this.socket = socket;

    socket.on("connect", () => {
      this.setState("connected");
    });

    socket.on("connect_error", (err) => {
      this.lastError = err.message;
      // 认证失败（等效于旧 WebSocket close code 4500）时进入 error 状态，不自动重连
      if (err.message === "unauthorized" || err.message === "rate_limited" || err.message === "agent not found") {
        this.setState("error", err.message);
        socket.disconnect();
      }
    });

    socket.on("disconnect", (reason, detail) => {
      if (reason === "io client disconnect") {
        this.setState("disconnected");
        return;
      }
      // 服务端主动断开或错误（等效于 4500），禁止自动重连
      if (reason === "io server disconnect") {
        const detailAny = detail as Record<string, unknown> | undefined;
        if (detailAny?.description === "unauthorized" || detailAny?.description === "rate_limited") {
          this.setState("error", detailAny.description as string);
          return;
        }
        this.lastError = reason;
      }
      // ping timeout / transport error → 依赖内置 reconnection 重连
    });

    socket.on("reconnect_attempt", (attempt) => {
      this.emit("reconnecting", { attempt, maxAttempts: 10 });
    });

    socket.on("reconnect_failed", () => {
      this.setState("error", this.lastError ?? "Reconnection failed");
      this.emit("reconnectFailed");
    });

    socket.on("message", (data: string) => {
      this.emit("message", data);
    });
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.socket = null;
    this.setState("disconnected");
  }

  send(data: string): void {
    if (!this.socket?.connected) {
      throw new Error("Socket not connected");
    }
    this.socket.send(data);
  }

  private setState(state: TransportState, message?: string): void {
    this._state = state;
    const detail: CloseEvent | undefined = message
      ? ({ code: state === "error" ? 4001 : 1011, reason: message, wasClean: false } as CloseEvent)
      : undefined;
    this.emit("state", { state, detail });
  }
}

/** 向后兼容：导出 WSTransport 别名 */
export { SocketIOTransport as WSTransport };
