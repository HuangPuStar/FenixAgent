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
 * 纯 WebSocket 传输层，不知道 ACP 协议。
 *
 * 职责：
 * - 连接/断开 WebSocket
 * - 自动重连（指数退避 + jitter，最多 5 次，连接稳定才重置计数）
 * - 收发原始字符串
 * - 传播连接状态和关闭原因
 */
export class WSTransport extends EventEmitter<TransportEvents> {
  private ws: WebSocket | null = null;
  private _state: TransportState = "disconnected";
  private url = "";
  private reconnectAttempt = 0;
  private static readonly MAX_RECONNECT_ATTEMPTS = 5;
  private static readonly BASE_DELAY_MS = 1000;
  private static readonly MAX_DELAY_MS = 30000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private manualDisconnect = false;
  /** 连接成功的时间戳，用于判断连接是否稳定 */
  private connectedAt = 0;
  /** 连接稳定阈值：超过此时间才视为有效连接并重置重连计数器 */
  private static readonly STABLE_THRESHOLD_MS = 5000;

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
        // 记录连接成功时间，延迟重置重连计数器
        this.connectedAt = Date.now();
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

        // 4500 = 远程节点不可用（machine_unavailable），不自动重连，等待用户手动触发
        if (event.code === 4500) {
          this.setState("error", event);
          return;
        }

        // 连接稳定超过阈值才视为有效连接，重置重连计数器
        // 防止 relay 接受连接但 agent 不可达时立即断开导致的无限重连循环
        const wasStable = this.connectedAt > 0 && Date.now() - this.connectedAt >= WSTransport.STABLE_THRESHOLD_MS;
        if (wasStable) {
          this.reconnectAttempt = 0;
        }
        this.connectedAt = 0;

        // 尝试重连
        if (this.reconnectAttempt < WSTransport.MAX_RECONNECT_ATTEMPTS) {
          this.reconnectAttempt++;
          this.emit("reconnecting", {
            attempt: this.reconnectAttempt,
            maxAttempts: WSTransport.MAX_RECONNECT_ATTEMPTS,
          });
          const rawDelay = Math.min(
            WSTransport.BASE_DELAY_MS * 2 ** (this.reconnectAttempt - 1),
            WSTransport.MAX_DELAY_MS,
          );
          // Full jitter: randomize between 50%-100% of raw delay
          const delay = Math.round(rawDelay * (0.5 + Math.random() * 0.5));
          this.reconnectTimer = setTimeout(() => {
            this.createConnection();
          }, delay);
        } else {
          this.setState("error", event);
          this.emit("reconnectFailed");
        }
      };
    } catch (_error) {
      this.setState("error");
      this.emit("reconnectFailed");
    }
  }

  private closeWs(): void {
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      try {
        old.close();
      } catch {
        /* ignore */
      }
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
