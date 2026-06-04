import { createLogger } from "@fenix/logger";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import type { RemoteTransport } from "./remote-transport";

const logger = createLogger("remote-relay");

export class RemoteRelayHandle implements EngineRelayHandle {
  private _state: "open" | "closed" = "open";
  private unsubSession: (() => void) | null = null;
  private messageListeners = new Set<(message: EngineRelayMessage) => void>();
  private capsSent = false;

  constructor(
    private transport: RemoteTransport,
    private instanceId: string,
    private sessionId: string,
    private agentCapabilities: Record<string, unknown> | null = null,
  ) {
    this.unsubSession = transport.onSessionMessage((instId, _sessId, msg) => {
      if (instId !== instanceId) return;
      const payload = msg.payload as Record<string, unknown> | undefined;
      if (!payload || typeof payload !== "object") return;

      // 传输层消息（status/error/pong 等）：直接透传
      if (typeof payload.type === "string") {
        logger.info("← agent transport msg", { instanceId, type: payload.type, payload: payload.payload });
        for (const listener of this.messageListeners) {
          listener({ type: payload.type, payload: payload.payload });
        }
        return;
      }

      // JSON-RPC 消息：透传为 { type: "jsonrpc", payload } 格式
      if (payload.jsonrpc === "2.0") {
        logger.info("← agent jsonrpc", { instanceId, method: payload.method, id: payload.id });
        for (const listener of this.messageListeners) {
          listener(payload as unknown as EngineRelayMessage);
        }
        return;
      }
    });
  }

  get state(): "open" | "closed" {
    return this._state;
  }

  onMessage(listener: (message: EngineRelayMessage) => void): () => void {
    // 首次注册 listener 时，发送缓存的 agent capabilities
    if (!this.capsSent && this.agentCapabilities) {
      this.capsSent = true;
      listener({ type: "status", payload: { connected: true, capabilities: this.agentCapabilities } });
    }
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  send(message: EngineRelayMessage): void {
    if (this._state !== "open") {
      throw new Error("RemoteRelayHandle is closed");
    }
    logger.info("→ agent relay", { instanceId: this.instanceId, payload: JSON.stringify(message).slice(0, 300) });
    this.transport.send({
      type: "relay",
      instance_id: this.instanceId,
      session_id: this.sessionId,
      payload: message,
    });
  }

  async close(_code?: number, _reason?: string): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    this.unsubSession?.();
    this.unsubSession = null;
    this.messageListeners.clear();
    logger.info("→ agent relay_close", { instanceId: this.instanceId });
    this.transport.send({
      type: "relay_close",
      instance_id: this.instanceId,
      session_id: this.sessionId,
    });
  }
}
