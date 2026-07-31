// packages/acp-server/src/yjs-ws-client.ts
// 同构 Yjs WebSocket 客户端，兼容浏览器和 Bun。
// URL 由调用方传入，解决 client/server 不同端口/环境的问题。

/** 服务端已明确告知当前连接不可恢复时，前端不应自动重连的关闭码。 */
const NO_RECONNECT_CODES = new Set([
  4001, // instance idle/activity reclaim
  4500, // machine_unavailable
  4501, // client_keepalive_timeout
]);

/** 重连间隔（指数退避），单位毫秒 */
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export type YjsWsState = "connecting" | "connected" | "disconnected" | "error";

export interface YjsWsError {
  code?: string;
  message?: string;
}

export interface YjsWsClose {
  code: number;
  reason: string;
}

export interface YjsWsOptions {
  /** WS 连接地址（由调用方构造，适配不同端口/环境） */
  url: string;
  /** 收到 yjs:update 消息时回调，docName 如 "chat:rcs_xxx" / "session:rcs_xxx" */
  onYjsUpdate: (docName: string, data: Uint8Array) => void;
  /** 连接状态变化回调 */
  onConnectionState?: (state: YjsWsState) => void;
  /** 收到服务端安全错误帧时回调 */
  onError?: (error: YjsWsError) => void;
  /** 连接关闭时回调关闭码与原因 */
  onClose?: (close: YjsWsClose) => void;
}

export interface YjsWsClient {
  connect(): void;
  disconnect(): void;
  send(data: unknown): void;
  isConnected(): boolean;
}

/**
 * 创建 Yjs WebSocket 客户端。
 *
 * 自动处理连接、断线重连（指数退避）、
 * 解析 yjs:update 消息并 base64 解码为 Uint8Array。
 *
 * @example
 * ```ts
 * const client = createYjsWsClient({
 *   url: `ws://localhost:3000/acp/yjs/${agentId}`,
 *   onYjsUpdate: (docName, data) => {
 *     if (docName.startsWith("chat:")) chatApply(data);
 *     else if (docName.startsWith("session:")) sessionApply(data);
 *   },
 *   onConnectionState: (state) => console.log("WS:", state),
 * });
 * client.connect();
 * // ...
 * client.disconnect();
 * ```
 */
export function createYjsWsClient(options: YjsWsOptions): YjsWsClient {
  const { url, onYjsUpdate, onConnectionState, onError, onClose } = options;

  let ws: WebSocket | null = null;
  let reconnectDelayIdx = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function setState(state: YjsWsState) {
    onConnectionState?.(state);
  }

  function scheduleReconnect() {
    if (destroyed) return;
    const delay = RECONNECT_DELAYS[reconnectDelayIdx] ?? RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1];
    reconnectTimer = setTimeout(() => {
      if (destroyed) return;
      reconnectDelayIdx = Math.min(reconnectDelayIdx + 1, RECONNECT_DELAYS.length - 1);
      connect();
    }, delay);
  }

  function connect() {
    if (destroyed) return;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

    setState("connecting");
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      if (destroyed || ws !== socket) return;
      reconnectDelayIdx = 0;
      setState("connected");
    };

    socket.onmessage = (event: MessageEvent) => {
      if (destroyed || ws !== socket) return;
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
        if (msg.type === "error") {
          const payload = msg.payload;
          if (payload && typeof payload === "object") {
            const record = payload as Record<string, unknown>;
            onError?.({
              code: typeof record.code === "string" ? record.code : undefined,
              message: typeof record.message === "string" ? record.message : undefined,
            });
          }
          return;
        }
        if (msg.type === "yjs:update") {
          const docName = msg.docName as string;
          const base64 = msg.data as string;
          if (docName && base64) {
            // 解码 base64 → Uint8Array（浏览器用 atob，Bun 同样支持）
            const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
            onYjsUpdate(docName, binary);
          }
        }
      } catch {
        console.warn("[yjs-ws] failed to parse msg:", (event.data as string)?.slice(0, 100));
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (destroyed || ws !== socket) return;
      ws = null;
      const close = { code: event.code, reason: event.reason };
      onClose?.(close);
      // 服务端主动关闭码表示当前连接不可自动恢复，交由上层提供手动恢复入口。
      if (NO_RECONNECT_CODES.has(event.code)) {
        setState("error");
        return;
      }
      setState("disconnected");
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (destroyed || ws !== socket) return;
      // onclose 会跟随触发，统一处理
    };
  }

  function disconnect() {
    destroyed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    setState("disconnected");
  }

  function send(data: unknown) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    } else {
      console.warn("[yjs-ws] send FAILED: readyState=", ws?.readyState);
    }
  }

  function isConnected() {
    return ws?.readyState === WebSocket.OPEN;
  }

  return { connect, disconnect, send, isConnected };
}
