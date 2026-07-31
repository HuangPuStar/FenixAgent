import type { ClientConnection, SharedRelay } from "./types";

export class ConnectionRegistry {
  private readonly clients = new Map<string, ClientConnection>();
  private readonly pendingBuffers = new Map<string, string[]>();
  private readonly sharedRelays = new Map<string, SharedRelay>();
  private readonly relayAcquisitions = new Map<string, Promise<SharedRelay>>();

  get clientCount(): number {
    return this.clients.size;
  }

  createPending(wsId: string): void {
    this.pendingBuffers.set(wsId, []);
  }

  tryCreatePending(wsId: string, maxClients: number): boolean {
    if (this.clients.size + this.pendingBuffers.size >= maxClients) return false;
    this.createPending(wsId);
    return true;
  }

  canPromotePending(wsId: string, maxClients: number): boolean {
    return this.pendingBuffers.has(wsId) && this.clients.size < maxClients;
  }

  bufferPending(wsId: string, message: string): void {
    const pending = this.pendingBuffers.get(wsId);
    if (pending) {
      pending.push(message);
      return;
    }
    const client = this.clients.get(wsId);
    if (client && !client.relayReady) client.pendingMessages.push(message);
  }

  consumePending(wsId: string): string[] | undefined {
    const client = this.clients.get(wsId);
    if (client) {
      if (client.pendingMessages.length === 0) return;
      return client.pendingMessages.splice(0);
    }
    const pending = this.pendingBuffers.get(wsId);
    this.pendingBuffers.delete(wsId);
    return pending;
  }

  discardPending(wsId: string): void {
    this.pendingBuffers.delete(wsId);
  }

  addClient(wsId: string, client: ClientConnection): void {
    const pending = this.consumePending(wsId);
    if (pending?.length) client.pendingMessages.push(...pending);
    this.clients.set(wsId, client);
  }

  getClient(wsId: string): ClientConnection | undefined {
    return this.clients.get(wsId);
  }

  removeClient(wsId: string): ClientConnection | undefined {
    const client = this.clients.get(wsId);
    this.clients.delete(wsId);
    return client;
  }

  forEachClient(callback: (client: ClientConnection) => void): void {
    for (const client of this.clients.values()) {
      callback(client);
    }
  }

  forEachByInstance(agentId: string, instanceId: string, callback: (client: ClientConnection) => void): void {
    for (const client of this.clients.values()) {
      if (client.agentId === agentId && client.instanceId === instanceId) {
        callback(client);
      }
    }
  }

  forEachByInstanceUser(
    agentId: string,
    instanceId: string,
    userId: string,
    callback: (client: ClientConnection) => void,
  ): void {
    for (const client of this.clients.values()) {
      if (client.agentId === agentId && client.instanceId === instanceId && client.userId === userId) {
        callback(client);
      }
    }
  }

  forEachByRcsSession(rcsSessionId: string, callback: (client: ClientConnection) => void): void {
    for (const client of this.clients.values()) {
      if (client.rcsSessionId === rcsSessionId) {
        callback(client);
      }
    }
  }

  findActiveSessionId(agentId: string, instanceId: string): string | undefined {
    for (const client of this.clients.values()) {
      if (client.agentId === agentId && client.instanceId === instanceId) {
        return client.acpSessionId ?? undefined;
      }
    }
    return;
  }

  findActiveSessionIdByUser(agentId: string, instanceId: string, userId: string): string | undefined {
    for (const client of this.clients.values()) {
      if (client.agentId === agentId && client.instanceId === instanceId && client.userId === userId) {
        return client.acpSessionId ?? undefined;
      }
    }
    return;
  }

  hasActiveSessionId(agentId: string, instanceId: string, acpSessionId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.agentId === agentId && client.instanceId === instanceId && client.acpSessionId === acpSessionId) {
        return true;
      }
    }
    return false;
  }

  hasStatusReceived(agentId: string, instanceId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.agentId === agentId && client.instanceId === instanceId && client.agentStatusReceived) {
        return true;
      }
    }
    return false;
  }

  /** 检查指定用户的 status 是否已收到（同一实例不同用户各自独立） */
  hasStatusReceivedByUser(agentId: string, instanceId: string, userId: string): boolean {
    for (const client of this.clients.values()) {
      if (
        client.agentId === agentId &&
        client.instanceId === instanceId &&
        client.userId === userId &&
        client.agentStatusReceived
      ) {
        return true;
      }
    }
    return false;
  }

  private makeRelayKey(instanceId: string, userId: string, rcsSessionId: string): string {
    // 多实例隔离：rcsSessionId 纳入 relay key，确保同一 instance 不同 session 各自拥有独立 relay
    return `${instanceId}:${userId}:${rcsSessionId}`;
  }

  getShared(instanceId: string, userId: string, rcsSessionId: string): SharedRelay | undefined {
    return this.sharedRelays.get(this.makeRelayKey(instanceId, userId, rcsSessionId));
  }

  addShared(shared: SharedRelay): void {
    this.sharedRelays.set(this.makeRelayKey(shared.instanceId, shared.userId, shared.rcsSessionId), shared);
  }

  acquireExisting(instanceId: string, userId: string, rcsSessionId: string): SharedRelay | undefined {
    const shared = this.sharedRelays.get(this.makeRelayKey(instanceId, userId, rcsSessionId));
    if (shared) shared.refCount++;
    return shared;
  }

  async acquireRelay(
    instanceId: string,
    userId: string,
    rcsSessionId: string,
    factory: () => Promise<SharedRelay>,
  ): Promise<{ shared: SharedRelay; created: boolean }> {
    const relayKey = this.makeRelayKey(instanceId, userId, rcsSessionId);
    const existing = this.sharedRelays.get(relayKey);
    if (existing) {
      existing.refCount++;
      return { shared: existing, created: false };
    }

    let acquisition = this.relayAcquisitions.get(relayKey);
    const created = !acquisition;
    if (!acquisition) {
      acquisition = factory()
        .then((shared) => {
          shared.refCount = 0;
          this.sharedRelays.set(relayKey, shared);
          return shared;
        })
        .finally(() => {
          this.relayAcquisitions.delete(relayKey);
        });
      this.relayAcquisitions.set(relayKey, acquisition);
    }

    const shared = await acquisition;
    shared.refCount++;
    return { shared, created };
  }

  release(instanceId: string, userId: string, rcsSessionId: string): SharedRelay | undefined {
    const relayKey = this.makeRelayKey(instanceId, userId, rcsSessionId);
    const shared = this.sharedRelays.get(relayKey);
    if (!shared) return;

    shared.refCount--;
    if (shared.refCount > 0) return;

    this.sharedRelays.delete(relayKey);
    return shared;
  }

  /** 请求指定 instance 的客户端关闭；实际资源释放统一由 WsLifecycle.handleClose 完成。 */
  closeClientsByInstance(instanceId: string, code = 1000, reason = "instance closed"): void {
    for (const client of this.clients.values()) {
      if (client.instanceId !== instanceId) continue;
      try {
        client.ws.close(code, reason);
      } catch {
        // 单连接失败不阻塞其他客户端关闭
      }
    }
  }

  /** 关闭所有客户端连接（graceful shutdown） */
  closeAll(code?: number, reason?: string): void {
    for (const [, client] of this.clients) {
      try {
        client.relayUnsub?.();
        client.relayHandle?.close?.(code ?? 1001, reason ?? "server_shutdown");
      } catch {
        // ignore
      }
      clearInterval(client.keepalive);
    }
    this.clients.clear();
  }

  /** 迭代所有客户端（用于外部关闭逻辑） */
  forEachAllClients(callback: (client: ClientConnection) => void): void {
    for (const client of this.clients.values()) {
      callback(client);
    }
  }
}
