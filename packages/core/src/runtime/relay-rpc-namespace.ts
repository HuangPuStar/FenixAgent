import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";

type RpcId = number | string;
type Rpc = Record<string, unknown>;
interface RequestOwner {
  scope: RelayRpcScope;
  localId: RpcId;
  method: string;
}
type Listener = (message: EngineRelayMessage) => void;

function jsonRpc(message: EngineRelayMessage): Rpc | undefined {
  const raw = message as unknown as Rpc;
  if (raw.jsonrpc === "2.0") return raw;
  const payload = raw.payload;
  if (typeof payload === "object" && payload !== null && "jsonrpc" in payload && payload.jsonrpc === "2.0") {
    return payload as Rpc;
  }
  return;
}
function withId(message: EngineRelayMessage, id: RpcId): EngineRelayMessage {
  const raw = message as unknown as Rpc;
  return (raw.jsonrpc === "2.0"
    ? { ...raw, id }
    : { ...raw, payload: { ...(raw.payload as Rpc), id } }) as unknown as EngineRelayMessage;
}
function sessionId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("sessionId" in value)) return;
  return typeof value.sessionId === "string" && value.sessionId ? value.sessionId : undefined;
}
const namespaces = new WeakMap<EngineRelayHandle, RelayRpcNamespace>();

/** The physical connection owns wire IDs, including gaps with no active consumers. */
class RelayRpcNamespace {
  private nextId = 0;
  private requests = new Map<RpcId, RequestOwner>();
  private readonly listeners = new Map<RelayRpcScope, Set<Listener>>();
  private unsubscribePhysical?: () => void;
  private subscribing = false;

  constructor(private readonly physical: EngineRelayHandle) {}

  send(scope: RelayRpcScope, message: EngineRelayMessage): Promise<void> | void {
    const rpc = jsonRpc(message);
    const target = rpc?.method ? sessionId(rpc.params) : undefined;
    if (target) scope.sessions.add(target);
    if (!rpc?.method || (typeof rpc.id !== "number" && typeof rpc.id !== "string")) return scope.physical.send(message);
    if (this.nextId === Number.MAX_SAFE_INTEGER) throw new Error("Physical relay RPC namespace exhausted");
    const wireId = ++this.nextId;
    this.requests.set(wireId, { scope, localId: rpc.id, method: String(rpc.method) });
    scope.pending.add(wireId);
    try {
      const sent = scope.physical.send(withId(message, wireId));
      if (sent)
        return sent.catch((error) => {
          this.forget(scope, wireId);
          throw error;
        });
    } catch (error) {
      this.forget(scope, wireId);
      throw error;
    }
  }

  subscribe(scope: RelayRpcScope, listener: Listener): () => void {
    let listeners = this.listeners.get(scope);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(scope, listeners);
    }
    listeners.add(listener);
    try {
      this.listen();
    } catch (error) {
      this.unsubscribe(scope, listener);
      throw error;
    }
    return () => this.unsubscribe(scope, listener);
  }

  private listen(): void {
    if (this.unsubscribePhysical || this.subscribing || !this.physical.onMessage) return;
    this.subscribing = true;
    try {
      // Remote transports may allocate one wrapper per callback, so routing happens before fan-out.
      const unsubscribe = this.physical.onMessage((message) => this.dispatch(message));
      if (this.listeners.size) this.unsubscribePhysical = unsubscribe;
      else unsubscribe();
    } finally {
      this.subscribing = false;
    }
  }

  private dispatch(message: EngineRelayMessage): void {
    const rpc = jsonRpc(message);
    if (rpc && !rpc.method && ("result" in rpc || "error" in rpc)) {
      const owner = typeof rpc.id === "number" || typeof rpc.id === "string" ? this.requests.get(rpc.id) : undefined;
      if (!owner) return;
      this.forget(owner.scope, rpc.id as RpcId);
      if (owner.method === "session/new") {
        const created = sessionId(rpc.result);
        if (created) owner.scope.sessions.add(created);
      }
      this.emit(owner.scope, withId(message, owner.localId));
      return;
    }
    const target = rpc ? sessionId(rpc.params) : undefined;
    for (const scope of [...this.listeners.keys()]) {
      if (!target || scope.acceptsSession(target)) this.emit(scope, message);
    }
  }

  private emit(scope: RelayRpcScope, message: EngineRelayMessage): void {
    for (const listener of this.listeners.get(scope) ?? []) {
      try {
        listener(message);
      } catch (error) {
        // Consumer faults cannot prevent another lease from receiving its response or status.
        console.error("[core-relay] Consumer callback failed", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
  private unsubscribe(scope: RelayRpcScope, listener: Listener): void {
    const listeners = this.listeners.get(scope);
    listeners?.delete(listener);
    if (listeners?.size === 0) this.listeners.delete(scope);
    this.detachIfUnused();
  }
  private detachIfUnused(): void {
    if (this.listeners.size) return;
    const unsubscribe = this.unsubscribePhysical;
    this.unsubscribePhysical = undefined;
    unsubscribe?.();
  }
  close(scope: RelayRpcScope): void {
    for (const id of scope.pending) this.forget(scope, id);
    this.listeners.delete(scope);
    this.detachIfUnused();
  }
  private forget(scope: RelayRpcScope, id: RpcId): void {
    if (this.requests.get(id)?.scope === scope) this.requests.delete(id);
    scope.pending.delete(id);
  }
}

/** A lease keeps local RPC IDs and session subscriptions private without owning the transport. */
export class RelayRpcScope {
  readonly pending = new Set<RpcId>();
  readonly sessions = new Set<string>();
  private subscribedSession: string | null = null;
  private readonly namespace: RelayRpcNamespace;
  constructor(readonly physical: EngineRelayHandle) {
    let namespace = namespaces.get(physical);
    if (!namespace) {
      namespace = new RelayRpcNamespace(physical);
      namespaces.set(physical, namespace);
    }
    this.namespace = namespace;
  }
  /** Map only client requests; replies to Agent permission requests preserve their original IDs. */
  send(message: EngineRelayMessage): Promise<void> | void {
    return this.namespace.send(this, message);
  }
  /** Restored server bindings need notification delivery before any targeted RPC is sent. */
  setSessionSubscription(sessionId: string | null): void {
    // A confirmed binding retires previous replay targets without invalidating their pending RPC responses.
    this.sessions.clear();
    this.subscribedSession = sessionId;
  }
  /** Explicit bindings and in-flight protocol targets share the same notification boundary. */
  acceptsSession(sessionId: string): boolean {
    return this.subscribedSession === sessionId || this.sessions.has(sessionId);
  }
  /** All scopes share one physical listener; response ownership is resolved before local fan-out. */
  subscribe(listener: Listener): () => void {
    return this.namespace.subscribe(this, listener);
  }
  /** Releasing a lease invalidates its requests while the physical counter continues. */
  close(): void {
    this.namespace.close(this);
    this.sessions.clear();
    this.subscribedSession = null;
  }
}
