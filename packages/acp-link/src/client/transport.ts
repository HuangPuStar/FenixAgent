import { EventEmitter } from "./emitter.js";

export type TransportState = "connecting" | "connected" | "disconnected" | "error";

export interface TransportEvents {
  state: { state: TransportState; detail?: CloseEvent };
  message: string;
  reconnecting: { attempt: number; maxAttempts: number };
  reconnectFailed: void;
}

/**
 * 纯 WebSocket 传输层，不知道 ACP 协议。
 *
 * 职责：
 * - 连接/断开 WebSocket
 * - 自动重连（指数退避，最多 3 次）
 * - 收发原始字符串
 * - 传播连接状态和关闭原因
 */
export class WSTransport extends EventEmitter<TransportEvents> {
  private ws: WebSocket | null = null;
  private _state: TransportState = "disconnected";
  private url = "";
  private reconnectAttempt = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 3;
  private static readonly BASE_DELAY_MS = 1000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;

  get state(): TransportState {
    return this._state;
  }

  connect(url: string): void {
    this.manualDisconnect = false;
    this.url = url;
    this.reconnectAttempt = 0;
    this.createConnection();
  }

  disconnect(): void {
    this.manualDisconnect = true;
    this.clearReconnectTimer();
    this.closeWs();
  }

  /** 关闭连接但允许自动重连（心跳超时时使用）。 */
  close(): void {
    this.closeWs();
  }

  send(data: string): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(data);
  }

  private createConnection(): void {
    // 清理旧连接
    this.closeWs();
    this.setState("connecting");

    try {
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.onopen = () => {
        if (this.ws !== ws) return;
        this.reconnectAttempt = 0;
        this.setState("connected");
      };

      ws.onmessage = (event) => {
        if (this.ws !== ws) return;
        this.emit("message", event.data as string);
      };

      ws.onerror = () => {
        if (this.ws !== ws) return;
      };

      ws.onclose = (event) => {
        if (this.ws !== ws) return;
        this.ws = null;

        // 正常关闭或手动断开，不重连
        if (this.manualDisconnect || event.code === 1000) {
          this.setState("disconnected", event);
          return;
        }

        // 尝试重连
        if (this.reconnectAttempt < WSTransport.MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempt++;
          this.emit("reconnecting", {
            attempt: this.reconnectAttempt,
            maxAttempts: WSTransport.MAX_RECONNECT_ATTEMPTS,
          });
          const delay = WSTransport.BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt - 1);
          this.reconnectTimer = setTimeout(() => {
            this.createConnection();
          }, delay);
        } else {
          this.setState("error", event);
          this.emit("reconnectFailed");
        }
      };
    } catch (error) {
      this.setState("error");
      this.emit("reconnectFailed");
    }
  }

  private closeWs(): void {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try { old.close(); } catch { /* ignore */ }
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setState(state: TransportState, detail?: CloseEvent): void {
    this._state = state;
    this.emit("state", { state, detail });
  }
}
