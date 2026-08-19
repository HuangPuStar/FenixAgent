// packages/chat-channel/src/channel/connection-registry.ts
// 连接注册表（迁移自 src/transport/relay/yjs-frontend/connection-registry.ts，语义原样保留）。
//
// 职责：
// - 按 wsId 管理 pending / active 客户端（连接配额由 gateway 通过 tryCreatePending 检查）；
// - 按 rcsSessionId 分组遍历客户端（广播隔离、断链通知）；
// - 按 instanceId+userId+rcsSessionId 管理共享 relay handle 的引用计数：
//   同一 instance + user 的多标签页共享同一 relay，引用计数归零才释放（CLAUDE.md YJS 不变量 8）。

import type { ClientConnection, SharedRelay } from "./connection-types";

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

  /** 尝试登记 pending 连接：当前活跃 + 挂起数已达上限时拒绝（配额 200 由 gateway 传入） */
  tryCreatePending(wsId: string, maxClients: number): boolean {
    if (this.clients.size + this.pendingBuffers.size >= maxClients) return false;
    this.createPending(wsId);
    return true;
  }

  canPromotePending(wsId: string, maxClients: number): boolean {
    return this.pendingBuffers.has(wsId) && this.clients.size < maxClients;
  }

  /** 缓冲未就绪连接的消息（pending 阶段或 relayReady=false 的 active 阶段） */
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

  /** 只读遍历：带出 wsId key（Observer 等只读消费者使用；ClientConnection 本身不自曝 wsId）。 */
  forEachClientEntry(callback: (wsId: string, client: ClientConnection) => void): void {
    for (const [wsId, client] of this.clients) callback(wsId, client);
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

  /** 按 rcsSessionId 定向遍历（广播隔离：同一会话的客户端才收到本会话数据） */
  forEachByRcsSession(rcsSessionId: string, callback: (client: ClientConnection) => void): void {
    for (const client of this.clients.values()) {
      if (client.rcsSessionId === rcsSessionId) {
        callback(client);
      }
    }
  }

  /** 返回同一 RCS 会话当前绑定的 ACP session ID。 */
  findActiveSessionIdByRcsSession(rcsSessionId: string): string | undefined {
    for (const client of this.clients.values()) {
      if (client.rcsSessionId === rcsSessionId) return client.acpSessionId ?? undefined;
    }
    return;
  }

  /** 检查同一 RCS 会话是否已有客户端收到 Agent status。 */
  hasStatusReceivedByRcsSession(rcsSessionId: string): boolean {
    for (const client of this.clients.values()) {
      if (client.rcsSessionId === rcsSessionId && client.agentStatusReceived) return true;
    }
    return false;
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

  /**
   * 获取共享 relay：已有则引用计数 +1；并发首次获取共享同一个 in-flight 创建 Promise，
   * 保证同时打开的多个连接只建立一个 relay 与一个监听器。
   */
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

  /** 释放一个引用；返回 shared relay 当且仅当引用计数归零（调用方负责最终资源释放） */
  release(instanceId: string, userId: string, rcsSessionId: string): SharedRelay | undefined {
    const relayKey = this.makeRelayKey(instanceId, userId, rcsSessionId);
    const shared = this.sharedRelays.get(relayKey);
    if (!shared) return;

    shared.refCount--;
    if (shared.refCount > 0) return;

    this.sharedRelays.delete(relayKey);
    return shared;
  }

  /** 请求指定 instance 的客户端关闭；实际资源释放统一由 gateway.handleClose 完成。 */
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
