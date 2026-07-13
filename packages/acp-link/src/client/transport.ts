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

    socket.on("disconnect", (reason) => {
      if (reason === "io client disconnect") {
        this.setState("disconnected");
      }
    });

    socket.on("reconnect_attempt", (attempt) => {
      this.emit("reconnecting", { attempt, maxAttempts: 10 });
    });

    socket.on("reconnect_failed", () => {
      this.setState("error");
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

  private setState(state: TransportState, _detail?: CloseEvent): void {
    this._state = state;
    this.emit("state", { state });
  }
}

/** 向后兼容：导出 WSTransport 别名 */
export { SocketIOTransport as WSTransport };
