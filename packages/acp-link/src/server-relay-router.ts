/** 本地 ACP server 的 relay 投递边界：响应定向发送，Agent 通知按会话投递。 */
export interface RelaySocket {
  send(data: string): void;
  readonly readyState: number;
}

/** 同一 Agent 实例的多个 relay 共享 ACP 连接，入站通知只能到达所属会话的活跃 relay。 */
export class ServerRelayRouter<Socket extends RelaySocket> {
  private readonly sockets = new Set<Socket>();
  private readonly sessionOwners = new Map<string, Set<Socket>>();

  /** 发送失败由 owner 清理该 relay 的交互请求与连接资源。 */
  constructor(private readonly onSendFailure: (socket: Socket, error: unknown) => void) {}

  /** 登记活跃 relay。 */
  add(socket: Socket): void {
    this.sockets.add(socket);
  }

  /** 释放 relay 的所有会话绑定。 */
  remove(socket: Socket): void {
    this.sockets.delete(socket);
    this.unbind(socket);
  }

  /** 释放一个 relay 的会话绑定，不影响同会话的其他 relay。 */
  unbind(socket: Socket): void {
    for (const [sessionId, owners] of this.sessionOwners) {
      owners.delete(socket);
      if (owners.size === 0) this.sessionOwners.delete(sessionId);
    }
  }

  /** 最近发起该会话操作的 relay 成为交互请求的接收者。 */
  bind(sessionId: string, socket: Socket): void {
    if (!this.sockets.has(socket)) return;
    this.unbind(socket);
    const owners = this.sessionOwners.get(sessionId) ?? new Set<Socket>();
    owners.add(socket);
    this.sessionOwners.set(sessionId, owners);
  }

  /** 仅选择一个会话 relay 承接权限或提问，避免重复应答。 */
  resolve(sessionId: string | undefined): Socket | undefined {
    const owners = sessionId ? this.sessionOwners.get(sessionId) : undefined;
    if (owners) {
      const activeOwners = [...owners].filter((socket) => socket.readyState === 1);
      return activeOwners.at(-1);
    }
    if (sessionId) return;
    const openSockets = [...this.sockets].filter((socket) => socket.readyState === 1);
    return openSockets.length === 1 ? openSockets[0] : undefined;
  }

  /** JSON-RPC 结果只回发起请求的 socket。 */
  sendTo(socket: Socket, message: unknown): void {
    if (!this.sockets.has(socket) || socket.readyState !== 1) return;
    try {
      socket.send(JSON.stringify(message));
    } catch (error) {
      this.remove(socket);
      console.warn("[acp-server] relay send failed:", error instanceof Error ? error.name : typeof error);
      try {
        this.onSendFailure(socket, error);
      } catch (cleanupError) {
        console.warn(
          "[acp-server] relay cleanup failed:",
          cleanupError instanceof Error ? cleanupError.name : typeof cleanupError,
        );
      }
    }
  }

  /** Agent 通知扇出到同会话的 relay；无会话标识时只允许唯一 relay。 */
  sendSession(sessionId: string | undefined, message: unknown): void {
    if (sessionId) {
      for (const socket of this.sessionOwners.get(sessionId) ?? []) this.sendTo(socket, message);
      return;
    }
    const owner = this.resolve(undefined);
    if (owner) this.sendTo(owner, message);
  }

  /** 状态变更属于整个 Agent 实例，发送给全部 relay。 */
  broadcast(message: unknown): void {
    for (const socket of this.sockets) this.sendTo(socket, message);
  }

  /** 实例停止时释放投递索引。 */
  clear(): void {
    this.sockets.clear();
    this.sessionOwners.clear();
  }
}
