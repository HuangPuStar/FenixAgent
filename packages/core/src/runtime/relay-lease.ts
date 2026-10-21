import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import { RelayRpcScope } from "./relay-rpc-namespace";

/** A consumer owns its listeners; only the runtime owner closes the physical relay. */
export function createRelayLease(physical: EngineRelayHandle): EngineRelayHandle {
  let released = false;
  const rpc = new RelayRpcScope(physical);
  const listeners = new Set<() => void>();
  return {
    get state() {
      return released ? "closed" : physical.state;
    },
    ready: physical.ready,
    send(message) {
      if (released) throw new Error("Relay lease has been released");
      return rpc.send(message);
    },
    setSessionSubscription(sessionId) {
      if (released) throw new Error("Relay lease has been released");
      rpc.setSessionSubscription(sessionId);
    },
    onMessage: physical.onMessage
      ? (listener) => {
          if (released) throw new Error("Relay lease has been released");
          const unsubscribe = rpc.subscribe((message) => {
            if (!released) listener(message);
          });
          listeners.add(unsubscribe);
          return () => {
            listeners.delete(unsubscribe);
            unsubscribe();
          };
        }
      : undefined,
    close() {
      if (released) return;
      released = true;
      rpc.close();
      for (const unsubscribe of listeners) unsubscribe();
      listeners.clear();
    },
  };
}

/** Runtime-owned in-flight connection, including a handle whose ready promise is still pending. */
export class RuntimeRelayConnection {
  readonly promise: Promise<EngineRelayHandle>;
  private relay?: EngineRelayHandle;
  private closed = false;
  private closedRelay?: EngineRelayHandle;
  private rejectStopped!: (error: Error) => void;

  constructor(connect: () => Promise<EngineRelayHandle>, assertCurrent: () => void) {
    const stopped = new Promise<never>((_, reject) => {
      this.rejectStopped = reject;
    });
    const connecting = Promise.resolve()
      .then(connect)
      .then(async (relay) => {
        this.relay = relay;
        try {
          if (this.closed) throw new Error("Runtime stopped during relay connection");
          assertCurrent();
          await Promise.race([Promise.resolve(relay.ready), stopped]);
          assertCurrent();
          return relay;
        } catch (error) {
          await this.closeRelay(relay);
          throw error;
        }
      });
    this.promise = Promise.race([connecting, stopped]);
  }

  private async closeRelay(relay: EngineRelayHandle): Promise<void> {
    if (this.closedRelay === relay) return;
    this.closedRelay = relay;
    await relay.close(1000, "runtime superseded or relay failed");
  }

  /** Stop wakes consumers immediately and reclaims handles that arrive after the stop. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.rejectStopped(new Error("Runtime stopped during relay connection"));
    if (this.relay) await this.closeRelay(this.relay);
  }
}
