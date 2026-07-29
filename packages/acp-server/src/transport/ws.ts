// packages/acp-server/src/yjs-ws-client.ts
// 同构 Yjs WebSocket 客户端，兼容浏览器和 Bun。
// URL 由调用方传入，解决 client/server 不同端口/环境的问题。

/** 重连间隔（指数退避），单位毫秒 */
const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000, 30000];

export type YjsWsState = "connecting" | "connected" | "disconnected";

export interface YjsWsOptions {
  /** WS 连接地址（由调用方构造，适配不同端口/环境） */
  url: string;
  /** 收到 yjs:update 消息时回调，docName 如 "chat:rcs_xxx" / "session:rcs_xxx" */
  onYjsUpdate: (docName: string, data: Uint8Array) => void;
  /** 连接状态变化回调 */
  onConnectionState?: (state: YjsWsState) => void;
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
  const { url, onYjsUpdate, onConnectionState } = options;

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
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectDelayIdx = 0;
      setState("connected");
    };

    ws.onmessage = (event: MessageEvent) => {
      try {
        const msg = JSON.parse(event.data as string) as Record<string, unknown>;
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

    ws.onclose = () => {
      ws = null;
      setState("disconnected");
      scheduleReconnect();
    };

    ws.onerror = () => {
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
