import type {
  EngineRelayHandle,
  EngineRelayMessage,
  EngineRelayState,
} from "@mothership/plugin-sdk";

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

function shouldIgnoreInbound(message: EngineRelayMessage): boolean {
  if (message.type === "keep_alive" || message.type === "pong") {
    return true;
  }
  if (message.type === "error") {
    const payloadMessage =
      typeof message.payload === "object" && message.payload && "message" in message.payload
        ? (message.payload as { message?: unknown }).message
        : undefined;
    if (typeof payloadMessage === "string" && payloadMessage.includes("keep_alive")) {
      return true;
    }
  }
  return false;
}

/**
 * 建立连接到本地 acp-link websocket 的 relay handle。
 */
export function createRelayHandle(
  input: CreateRelayHandleInput,
  dependencies: RelayHandleDependencies,
): OpencodeRelayHandle {
  const url = `ws://127.0.0.1:${input.port}/ws?token=${encodeURIComponent(input.token)}`;
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

  const emit = (message: EngineRelayMessage) => {
    if (shouldIgnoreInbound(message)) {
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
    socket.send(JSON.stringify({ type: "ping" }));
  }, keepAliveIntervalMs);

  socket.onopen = () => {
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
        emit(JSON.parse(line));
      } catch {
        // Ignore malformed relay frames from local acp-link.
      }
    }
  };

  socket.onclose = () => {
    state = "closed";
    clearInterval(keepalive);
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Relay closed before websocket open"));
    }
  };
  socket.onerror = () => {
    state = "closed";
    clearInterval(keepalive);
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
      return () => {
        listeners.delete(listener);
      };
    },
    send(message) {
      if (state !== "open") {
        throw new Error("Relay is closed");
      }
      if (message.type === "ping") {
        emit({ type: "pong" });
        return;
      }
      socket.send(JSON.stringify(message));
    },
    close(code, reason) {
      if (state === "closed") {
        return;
      }
      state = "closed";
      clearInterval(keepalive);
      socket.close(code, reason);
    },
  };
}
