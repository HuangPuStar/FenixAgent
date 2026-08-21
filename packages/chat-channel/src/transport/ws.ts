// packages/chat-channel/src/transport/ws.ts
// 同构 Yjs WebSocket 客户端，兼容浏览器和 Bun。
// URL 由调用方传入，解决 client/server 不同端口/环境的问题。

import { WEBSOCKET_CODES } from "acp-link/websocket-code";
import type { ActionAck, ActionError } from "../channel/types";
import { decodeYjsSyncFrame, encodeYjsStateVectorFrame } from "../protocol/update-frame";

/** 服务端已明确告知当前连接不可恢复时，前端不应自动重连的关闭码。 */
const NO_RECONNECT_CODES = new Set<number>([
  WEBSOCKET_CODES.INSTANCE_RECLAIMED.code,
  WEBSOCKET_CODES.INVALID_REFERENCE.code,
  WEBSOCKET_CODES.MACHINE_UNAVAILABLE.code,
  WEBSOCKET_CODES.KEEPALIVE_TIMEOUT.code,
  WEBSOCKET_CODES.SPAWN_REJECTED.code,
  WEBSOCKET_CODES.MACHINE_ALREADY_CONNECTED.code,
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
  /** replacement 帧：调用方必须销毁旧 Doc 并以该快照创建新副本。 */
  onYjsReplace?: (docName: string, generation: string, data: Uint8Array) => void;
  /** 当前本地 Doc 的 state vector；连接建立后用于请求差量同步。 */
  getYjsStateVectors?: () => Array<{ docName: string; generation: string; stateVector: Uint8Array }>;
  /** 连接状态变化回调 */
  onConnectionState?: (state: YjsWsState) => void;
  /** 收到服务端安全错误帧时回调 */
  onError?: (error: YjsWsError) => void;
  /** 连接关闭时回调关闭码与原因 */
  onClose?: (close: YjsWsClose) => void;
  /** 收到 action_ack 时回调（commandId 幂等响应；前端据此释放重试 ID 缓存） */
  onActionAck?: (ack: ActionAck) => void;
  /** 收到 action_error 帧时回调（commandId 幂等失败响应；前端据此释放重试 ID 缓存并展示错误） */
  onActionError?: (error: ActionError) => void;
}

export interface YjsWsClient {
  connect(): void;
  disconnect(): void;
  send(data: unknown): void;
  isConnected(): boolean;
}

/**
 * 把 onmessage 收到的二进制载荷归一为 Uint8Array 视图。
 * 接受 ArrayBuffer（binaryType=arraybuffer 的标准形态）与 TypedArray 视图（Bun /
 * 测试 fake 直接透传的形态）；其他形态（如未设置 binaryType 的 Blob）返回 null 丢弃。
 */
function toFrameBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as Uint8Array;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function toWebSocketBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * 创建 Yjs WebSocket 客户端。
 *
 * 自动处理连接、断线重连（指数退避）、解析消息帧：
 * - 二进制帧（SP-A4）：yjs:update 走 0x01 二进制帧，零拷贝解码为 Uint8Array；
 * - JSON 文本帧：error / action_ack / action_error 等控制消息。
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
  const {
    url,
    onYjsUpdate,
    onYjsReplace,
    getYjsStateVectors,
    onConnectionState,
    onError,
    onClose,
    onActionAck,
    onActionError,
  } = options;

  const generations = new Map<string, string>();
  const requestedGenerations = new Map<string, string>();

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
    // yjs:update 二进制帧要求以 ArrayBuffer 形态到达（浏览器默认 blob 需异步解包），
    // Bun 默认即 arraybuffer，显式设置保证两端一致。
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.onopen = () => {
      if (destroyed || ws !== socket) return;
      reconnectDelayIdx = 0;
      setState("connected");
      for (const vector of getYjsStateVectors?.() ?? []) {
        socket.send(
          toWebSocketBuffer(encodeYjsStateVectorFrame(vector.docName, vector.generation, vector.stateVector)),
        );
      }
    };

    socket.onmessage = (event: MessageEvent) => {
      if (destroyed || ws !== socket) return;
      const data = event.data;
      // 二进制 yjs:update 帧（SP-A4）：零拷贝解析，替代历史 base64+JSON 逐字节解码慢路径
      if (typeof data !== "string") {
        const bytes = toFrameBytes(data);
        if (bytes) {
          const frame = decodeYjsSyncFrame(bytes);
          if (!frame || frame.type === "state-vector") return;
          if (frame.type === "legacy-update") {
            if (!generations.has(frame.docName)) onYjsUpdate(frame.docName, frame.update);
            return;
          }
          if (frame.type === "replace") {
            generations.set(frame.docName, frame.generation);
            onYjsReplace?.(frame.docName, frame.generation, frame.update);
            return;
          }
          const current = generations.get(frame.docName);
          if (requestedGenerations.get(frame.docName) === frame.generation && current !== frame.generation) {
            requestedGenerations.delete(frame.docName);
            generations.set(frame.docName, frame.generation);
            onYjsReplace?.(frame.docName, frame.generation, frame.update);
            return;
          }
          if (current && current !== frame.generation) return;
          generations.set(frame.docName, frame.generation);
          onYjsUpdate(frame.docName, frame.update);
        }
        return;
      }
      try {
        const msg = JSON.parse(data) as Record<string, unknown>;
        if (msg.type === "yjs:sync-request" && Array.isArray(msg.docs)) {
          const local = new Map((getYjsStateVectors?.() ?? []).map((vector) => [vector.docName, vector]));
          for (const requested of msg.docs) {
            if (!requested || typeof requested !== "object") continue;
            const record = requested as Record<string, unknown>;
            if (typeof record.docName !== "string" || typeof record.generation !== "string") continue;
            const vector = local.get(record.docName);
            requestedGenerations.set(record.docName, record.generation);
            socket.send(
              toWebSocketBuffer(
                encodeYjsStateVectorFrame(
                  record.docName,
                  record.generation,
                  vector?.generation === record.generation ? vector.stateVector : new Uint8Array(),
                ),
              ),
            );
          }
          return;
        }
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
        if (msg.type === "action_ack") {
          onActionAck?.(msg as unknown as ActionAck);
          return;
        }
        if (msg.type === "action_error") {
          onActionError?.(msg as unknown as ActionError);
          return;
        }
      } catch {
        console.warn("[yjs-ws] failed to parse msg:", data.slice(0, 100));
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
