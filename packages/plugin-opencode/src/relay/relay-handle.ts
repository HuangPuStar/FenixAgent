import type { EngineRelayHandle, EngineRelayMessage, EngineRelayState } from "@fenix/plugin-sdk";

const RELAY_KEEPALIVE_INTERVAL_MS = 20_000;

export interface RelaySocket {
  readyState: number;
  onopen: ((event?: unknown) => void) | null;
  onmessage: ((event: { data: string | Buffer }) => void) | null;
  onclose: ((event?: { code?: number; reason?: string }) => void) | null;
  onerror: ((event?: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface RelayHandleDependencies {
  createWebSocket: (url: string) => RelaySocket;
  keepAliveIntervalMs?: number;
}

export interface CreateRelayHandleInput {
  instanceId: string;
  port: number;
  token: string;
}

export interface OpencodeRelayHandle extends EngineRelayHandle {
  readonly url: string;
  readonly ready: Promise<void>;
  onMessage(listener: (message: EngineRelayMessage) => void): () => void;
}

const KEEPALIVE_TYPE = "keep_alive";
const PONG_TYPE = "pong";
const PING_TYPE = "ping";
const CONNECT_TYPE = "connect";
const ERROR_TYPE = "error";

function shouldIgnoreInbound(message: EngineRelayMessage): boolean {
  if (message.type === KEEPALIVE_TYPE || message.type === PONG_TYPE) {
    return true;
  }
  if (message.type === ERROR_TYPE) {
    const payloadMessage =
      typeof message.payload === "object" && message.payload && "message" in message.payload
        ? (message.payload as { message?: unknown }).message
        : undefined;
    if (typeof payloadMessage === "string" && payloadMessage.includes(KEEPALIVE_TYPE)) {
      return true;
    }
  }
  return false;
}

/**
 * 建立连接到本地 acp-link websocket 的 relay handle。
 *
 * 消息缓冲：在第一个 onMessage 监听器注册之前，所有收到的非过滤消息
 * 会被缓冲。首个监听器注册时立即回放缓冲，避免 .then() 回调延迟注册
 * 导致 connect 响应（status）丢失的竞态问题。
 */
export function createRelayHandle(
  input: CreateRelayHandleInput,
  dependencies: RelayHandleDependencies,
): OpencodeRelayHandle {
  const url = `ws://127.0.0.1:${input.port}/ws?token=${encodeURIComponent(input.token)}`;
  console.log(
    `[RelayHandle] Creating relay to ${url.replace(/token=[^&]+/, "token=***")} for instance ${input.instanceId}`,
  );
  const socket = dependencies.createWebSocket(url);
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  const keepAliveIntervalMs = dependencies.keepAliveIntervalMs ?? RELAY_KEEPALIVE_INTERVAL_MS;
  let state: EngineRelayState = "open";
  let readySettled = socket.readyState === 1;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  if (readySettled) {
    resolveReady();
  }

  // 缓冲：onMessage 注册前收到的消息暂存，注册后立即回放
  const messageBuffer: EngineRelayMessage[] = [];
  let hasListeners = false;

  const flushBuffer = () => {
    if (messageBuffer.length === 0) return;
    const buffered = messageBuffer.splice(0);
    for (const msg of buffered) {
      for (const listener of listeners) {
        listener(msg);
      }
    }
  };

  const emit = (message: EngineRelayMessage) => {
    if (shouldIgnoreInbound(message)) {
      return;
    }
    if (!hasListeners) {
      messageBuffer.push(message);
      return;
    }
    for (const listener of listeners) {
      listener(message);
    }
  };

  const keepalive = setInterval(() => {
    if (state !== "open") {
      return;
    }
    socket.send(JSON.stringify({ type: PING_TYPE }));
  }, keepAliveIntervalMs);

  socket.onopen = () => {
    console.log(`[RelayHandle] WS opened for instance ${input.instanceId}, sending connect`);
    socket.send(JSON.stringify({ type: CONNECT_TYPE }));
    if (readySettled) {
      return;
    }
    readySettled = true;
    resolveReady();
  };

  socket.onmessage = (event) => {
    const text = typeof event.data === "string" ? event.data : event.data.toString();
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const parsed = JSON.parse(line);
        if (!shouldIgnoreInbound(parsed)) {
          console.log(
            `[RelayHandle] Inbound ← acp-link (${input.instanceId}): type=${parsed.type}${hasListeners ? "" : " (buffered)"}`,
          );
        }
        emit(parsed);
      } catch {
        // Ignore malformed relay frames from local acp-link.
      }
    }
  };

  socket.onclose = () => {
    console.log(`[RelayHandle] WS closed for instance ${input.instanceId}`);
    state = "closed";
    clearInterval(keepalive);
    emit({ type: "relay_closed", payload: { code: "relay_disconnected" } });
    messageBuffer.length = 0;
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Relay closed before websocket open"));
    }
  };
  socket.onerror = () => {
    console.error(`[RelayHandle] WS error for instance ${input.instanceId}`);
    state = "closed";
    clearInterval(keepalive);
    emit({ type: "relay_closed", payload: { code: "relay_error" } });
    messageBuffer.length = 0;
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Relay websocket errored before open"));
    }
  };

  return {
    url,
    ready,
    get state() {
      return state;
    },
    onMessage(listener) {
      listeners.add(listener);
      const wasEmpty = !hasListeners;
      hasListeners = true;
      if (wasEmpty) {
        flushBuffer();
      }
      return () => {
        listeners.delete(listener);
        hasListeners = listeners.size > 0;
      };
    },
    send(message) {
      if (state !== "open") {
        throw new Error("Relay is closed");
      }
      if (message.type === PING_TYPE) {
        emit({ type: PONG_TYPE });
        return;
      }
      console.log(`[RelayHandle] Outbound → acp-link (${input.instanceId}): type=${message.type}`);
      socket.send(JSON.stringify(message));
    },
    close(code, reason) {
      if (state === "closed") {
        return;
      }
      console.log(`[RelayHandle] Closing WS for instance ${input.instanceId}, code=${code} reason=${reason}`);
      state = "closed";
      clearInterval(keepalive);
      messageBuffer.length = 0;
      socket.close(code, reason);
    },
  };
}
