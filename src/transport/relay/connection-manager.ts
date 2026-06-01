import { log, error as logError } from "../../logger";
import type { ManagedConnection, RelayConnectionEntry } from "../../types/store";
import type { WsConnection } from "../ws-types";

export type { ManagedConnection, RelayConnectionEntry };

export class RelayConnectionManager {
  private connections = new Map<string, RelayConnectionEntry>();
  private shuttingDown = false;

  add(wsId: string, entry: RelayConnectionEntry): void {
    const existing = this.connections.get(wsId);
    if (existing) {
      if (existing.keepalive) clearInterval(existing.keepalive);
      if (existing.unsub) existing.unsub();
      if (existing.relayUnsub) existing.relayUnsub();
    }
    this.connections.set(wsId, entry);
  }

  get(wsId: string): RelayConnectionEntry | undefined {
    return this.connections.get(wsId);
  }

  remove(wsId: string): void {
    const entry = this.connections.get(wsId);
    if (!entry) return;
    if (entry.keepalive) clearInterval(entry.keepalive);
    if (entry.unsub) entry.unsub();
    if (entry.relayUnsub) entry.relayUnsub();
    this.connections.delete(wsId);
  }

  findByInstance(instanceId: string): ManagedConnection | undefined {
    for (const [wsId, entry] of this.connections) {
      if (entry.instanceId === instanceId) return { wsId, ...entry };
    }
    return;
  }

  findByAgentId(agentId: string): ManagedConnection[] {
    const results: ManagedConnection[] = [];
    for (const [wsId, entry] of this.connections) {
      if (entry.agentId === agentId) results.push({ wsId, ...entry });
    }
    return results;
  }

  hasOtherRelayForInstance(instanceId: string, excludeWsId?: string): boolean {
    for (const [wsId, entry] of this.connections) {
      if (entry.instanceId === instanceId && wsId !== excludeWsId) return true;
    }
    return false;
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  set isShuttingDown(value: boolean) {
    this.shuttingDown = value;
  }

  get size(): number {
    return this.connections.size;
  }

  entries(): IterableIterator<[string, RelayConnectionEntry]> {
    return this.connections.entries();
  }

  clear(): void {
    this.connections.clear();
  }
}

/** Send a JSON message to relay WS */
export function sendToRelayWs(ws: WsConnection, msg: object): void {
  if (ws.readyState !== 1) return;
  try {
    const payload = JSON.stringify(msg);
    ws.send(payload);
    log(`[ACP-Relay] Sent to frontend: type=${(msg as Record<string, unknown>).type} bytes=${payload.length}`);
  } catch (err) {
    logError("[ACP-Relay] send error:", err);
  }
}
