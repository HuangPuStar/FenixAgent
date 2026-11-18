/** 两条聊天连接的载荷计数；不保存 URL、消息正文或认证信息。 */
export class SocketByteCounter {
  private readonly sockets = new Map<string, "state" | "content">();
  private totals = this.empty();

  private empty() {
    return { state: { receivedBytes: 0, sentBytes: 0 }, content: { receivedBytes: 0, sentBytes: 0 } };
  }

  /** 接收 Chrome Network 事件，仅保留聊天连接分类和字节数。 */
  accept(method: string, params: Record<string, unknown>): void {
    const id = params.requestId;
    if (typeof id !== "string") return;
    if (method === "Network.webSocketCreated" && typeof params.url === "string") {
      const url = new URL(params.url);
      if (url.pathname.startsWith("/acp/yjs/"))
        this.sockets.set(id, url.searchParams.get("chatSync") === "1" ? "content" : "state");
      return;
    }
    if (method === "Network.webSocketClosed") {
      this.sockets.delete(id);
      return;
    }
    const kind = this.sockets.get(id);
    if (!kind || (method !== "Network.webSocketFrameReceived" && method !== "Network.webSocketFrameSent")) return;
    const frame = params.response;
    if (!frame || typeof frame !== "object" || !("payloadData" in frame) || typeof frame.payloadData !== "string")
      throw new Error("Invalid CDP WebSocket frame");
    const bytes =
      "opcode" in frame && frame.opcode === 2
        ? Buffer.from(frame.payloadData, "base64").byteLength
        : Buffer.byteLength(frame.payloadData);
    this.totals[kind][method === "Network.webSocketFrameReceived" ? "receivedBytes" : "sentBytes"] += bytes;
  }

  /** 开始下一轮；保留仍活跃 socket 的分类，以覆盖会话切换。 */
  reset(): void {
    this.totals = this.empty();
  }
  /** 返回独立快照，后续网络事件不会修改已保存的样本。 */
  snapshot() {
    return { state: { ...this.totals.state }, content: { ...this.totals.content } };
  }
}

interface CdpMessage {
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number };
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

/** 仅读取测量事件并安装页面观测；用户操作仍经 agent-browser 执行。 */
export class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private listener: (event: CdpMessage) => void = () => {};

  private constructor(private readonly socket: WebSocket) {
    socket.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`CDP command rejected (${message.error.code})`));
        else pending.resolve(message.result ?? {});
      } else this.listener(message);
    };
    socket.onclose = () => this.rejectPending();
  }

  /** 连接 agent-browser 返回的本地浏览器调试地址，失败有界退出。 */
  static async connect(url: string): Promise<CdpConnection> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("CDP connection timeout"));
      }, 5000);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        reject(new Error("CDP connection failed"));
      };
    });
    return new CdpConnection(socket);
  }

  /** 执行单个有超时的 CDP 命令，不把协议载荷写入日志。 */
  command(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timeout`));
      }, 15000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /** 每个测量器只持有一个事件订阅，避免重载期间观察者累积。 */
  onEvent(listener: (event: CdpMessage) => void): void {
    this.listener = listener;
  }

  private rejectPending(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP connection closed"));
    }
    this.pending.clear();
  }

  /** 清理所有等待者和 socket；只关闭自身调试连接。 */
  close(): void {
    this.rejectPending();
    this.listener = () => {};
    this.socket.close();
  }
}
