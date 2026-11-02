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
  /** 新协议二进制帧在 entry 创建前到达时的暂存（HELLO 可能在 open 异步初始化期间到达）。 */
  private readonly pendingBinaryBuffers = new Map<string, Uint8Array[]>();
  /** 与 `pendingBinaryBuffers` 同步维护的暂存字节数；消费/丢弃时必须一并清除，避免计数泄漏。 */
  private readonly pendingTextBytes = new Map<string, number>();
  private readonly pendingBinaryBytes = new Map<string, number>();
  private readonly sharedRelays = new Map<string, SharedRelay>();
  private readonly relayAcquisitions = new Map<string, Promise<SharedRelay>>();
  /** 未就绪连接最多暂存的新协议帧数，防止握手窗口被用作无界队列。 */
  private static readonly MAX_PENDING_BINARY_FRAMES = 8;
  /**
   * 未就绪连接暂存二进制帧的总字节上限。
   *
   * 只限帧数挡不住单帧体积：WS 单帧上限 10MiB，8 帧即约 80MiB/连接，握手窗口可被用来
   * 占满进程内存。64KiB 足以容纳握手期的 HELLO 等小帧，同时让暂存占用与连接数线性有界。
   */
  private static readonly MAX_PENDING_BINARY_BYTES = 64 * 1024;

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
  bufferPending(wsId: string, message: string): boolean {
    const client = this.clients.get(wsId);
    const pending =
      this.pendingBuffers.get(wsId) ?? (client && !client.relayReady ? client.pendingMessages : undefined);
    if (!pending) return false;
    const bytes = new TextEncoder().encode(message).byteLength;
    const held = this.pendingTextBytes.get(wsId) ?? 0;
    let cancellation = false;
    if (bytes <= 1024) {
      try {
        cancellation = JSON.parse(message)?.action === "cancel";
      } catch {
        /* 无效帧仍受普通消息预算约束。 */
      }
    }
    const reserve = cancellation ? 2 : 0;
    if (pending.length >= 64 + reserve || held + bytes > 1024 * 1024 + reserve * 1024) return false;
    if (cancellation) pending.unshift(message);
    else pending.push(message);
    this.pendingTextBytes.set(wsId, held + bytes);
    return true;
  }

  /** 诊断用：未就绪文本帧的实际 UTF-8 字节数。 */
  pendingTextByteCount(wsId: string): number {
    return this.pendingTextBytes.get(wsId) ?? 0;
  }

  consumePending(wsId: string): string[] | undefined {
    this.pendingTextBytes.delete(wsId);
    const client = this.clients.get(wsId);
    if (client) {
      if (client.pendingMessages.length === 0) return;
      return client.pendingMessages.splice(0);
    }
    const pending = this.pendingBuffers.get(wsId);
    this.pendingBuffers.delete(wsId);
    return pending;
  }

  /** 诊断用：未就绪文本帧数量（不消费）。 */
  pendingTextCount(wsId: string): number {
    return this.clients.get(wsId)?.pendingMessages.length ?? this.pendingBuffers.get(wsId)?.length ?? 0;
  }

  /** 诊断用：entry 创建前暂存的二进制帧数量（不消费）。 */
  pendingBinaryCount(wsId: string): number {
    return this.pendingBinaryBuffers.get(wsId)?.length ?? 0;
  }

  /**
   * 暂存 entry 创建前到达的新协议二进制帧；超过上限或连接已关闭时返回 false。
   *
   * 帧可能在 `handleOpen` 之前到达：路由层在 `open` 回调里先分配 wsId，再异步完成认证与
   * environment 解析，最后才调用 `handleOpen`（此时才登记 pending）。浏览器 `open` 后立即
   * 发送 HELLO，正好落在这段窗口里；若要求 pending 已存在，会把正常握手误判为 1008
   * `sync protocol unavailable`。缓冲仍按 wsId 限 8 帧与 64KiB，连接关闭时由 `discardPending` 清空。
   */
  bufferPendingBinary(wsId: string, frame: Uint8Array): boolean {
    const pending = this.pendingBinaryBuffers.get(wsId) ?? [];
    const bufferedBytes = this.pendingBinaryBytes.get(wsId) ?? 0;
    // 先按「本次帧完整入队后」的总字节判定：超限时不得改动任何状态，否则拒绝后仍会留下半个计数。
    if (bufferedBytes + frame.byteLength > ConnectionRegistry.MAX_PENDING_BINARY_BYTES) return false;
    if (pending.length >= ConnectionRegistry.MAX_PENDING_BINARY_FRAMES) return false;
    pending.push(frame);
    this.pendingBinaryBuffers.set(wsId, pending);
    this.pendingBinaryBytes.set(wsId, bufferedBytes + frame.byteLength);
    return true;
  }

  consumePendingBinary(wsId: string): Uint8Array[] | undefined {
    const pending = this.pendingBinaryBuffers.get(wsId);
    this.pendingBinaryBuffers.delete(wsId);
    this.pendingBinaryBytes.delete(wsId);
    return pending;
  }

  discardPending(wsId: string): void {
    this.pendingTextBytes.delete(wsId);
    this.pendingBuffers.delete(wsId);
    this.pendingBinaryBuffers.delete(wsId);
    this.pendingBinaryBytes.delete(wsId);
  }

  addClient(wsId: string, client: ClientConnection): void {
    const pending = this.consumePending(wsId);
    if (pending?.length) client.pendingMessages.push(...pending);
    this.clients.set(wsId, client);
    this.pendingTextBytes.set(
      wsId,
      client.pendingMessages.reduce((sum, text) => sum + new TextEncoder().encode(text).byteLength, 0),
    );
  }

  getClient(wsId: string): ClientConnection | undefined {
    return this.clients.get(wsId);
  }

  removeClient(wsId: string): ClientConnection | undefined {
    const client = this.clients.get(wsId);
    this.clients.delete(wsId);
    this.pendingTextBytes.delete(wsId);
    if (client) client.syncClosed = true;
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

  /** 释放页面引用；归零且无在途回复保留请求时返回待释放 relay。 */
  release(instanceId: string, userId: string, rcsSessionId: string, retain = false): SharedRelay | undefined {
    const relayKey = this.makeRelayKey(instanceId, userId, rcsSessionId);
    const shared = this.sharedRelays.get(relayKey);
    if (!shared) return;

    shared.refCount--;
    if (shared.refCount > 0 || retain) return;

    this.sharedRelays.delete(relayKey);
    return shared;
  }

  /** 按对象身份释放零引用 relay，迟到完成不能移除后继连接。 */
  releaseRetained(shared: SharedRelay): boolean {
    const key = this.makeRelayKey(shared.instanceId, shared.userId, shared.rcsSessionId);
    if (this.sharedRelays.get(key) !== shared || shared.refCount !== 0) return false;
    this.sharedRelays.delete(key);
    return true;
  }

  /** 请求指定 instance 的客户端关闭；实际资源释放统一由 gateway.handleClose 完成。 */
  closeClientsByInstance(instanceId: string, code = 1000, reason = "instance closed"): void {
    for (const shared of [...this.sharedRelays.values()]) {
      if (shared.instanceId === instanceId && shared.refCount === 0) shared.releaseRetained?.();
    }
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
    for (const shared of [...this.sharedRelays.values()]) {
      if (shared.refCount === 0) shared.releaseRetained?.();
    }
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
