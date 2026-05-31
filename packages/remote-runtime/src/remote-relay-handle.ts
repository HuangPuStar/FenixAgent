import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import type { RemoteTransport } from "./remote-transport";

export class RemoteRelayHandle implements EngineRelayHandle {
  private _state: "open" | "closed" = "open";
  private unsubSession: (() => void) | null = null;
  private messageListeners = new Set<(message: EngineRelayMessage) => void>();

  constructor(
    private transport: RemoteTransport,
    private instanceId: string,
    private sessionId: string,
  ) {
    this.unsubSession = transport.onSessionMessage((instId, sessId, msg) => {
      if (instId !== instanceId || sessId !== sessionId) return;
      for (const listener of this.messageListeners) {
        listener({ type: msg.type, payload: msg.payload });
      }
    });
  }

  get state(): "open" | "closed" {
    return this._state;
  }

  onMessage(listener: (message: EngineRelayMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  send(message: EngineRelayMessage): void {
    if (this._state !== "open") {
      throw new Error("RemoteRelayHandle is closed");
    }
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
    this.transport.send({
      type: "relay_close",
      instance_id: this.instanceId,
      session_id: this.sessionId,
    });
  }
}
