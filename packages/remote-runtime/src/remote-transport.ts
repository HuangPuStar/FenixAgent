import { createLogger } from "@fenix/logger";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

const logger = createLogger("remote-transport");

// ── 协议消息类型 ──────────────────────────────────

export interface TransportMessage {
  type: string;
  request_id?: string;
  instance_id?: string;
  session_id?: string;
  launch_spec?: AgentLaunchSpec;
  payload?: unknown;
  status?: string;
  message?: string;
  capabilities?: Record<string, unknown>;
}

export interface TransportSendOptions {
  timeout?: number;
}

/**
 * 与远程 acp-link 通信的最小传输接口。
 * 生产实现包装已有的 WsConnection，测试用 mock 实现此接口。
 */
export interface RemoteTransport {
  /** 发送消息并等待匹配 request_id 的回复 */
  sendAndWait(message: TransportMessage, options?: TransportSendOptions): Promise<TransportMessage>;
  /** 注册 session 消息监听器 */
  onSessionMessage(listener: (instanceId: string, sessionId: string, message: TransportMessage) => void): () => void;
  /** 单向发送，不等待回复 */
  send(message: TransportMessage): void;
  /** 外部路由注入收到的消息（由 RCS acp-ws-handler 调用，替代 onmessage 劫持） */
  injectMessage(message: TransportMessage): void;
}

// ── 默认超时 ──────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const PREPARE_TIMEOUT_MS = 60_000;

// ── 基于 WsConnection 的生产 Transport ──────────────────────────

export interface WsConnectionLike {
  readyState: number;
  send(data: string): void;
  onmessage: ((event: { data: string | Buffer }) => void) | null;
}

/**
 * 创建基于 WS 连接的 RemoteTransport。
 * 支持 onmessage 劫持（直连场景）和 injectMessage（RCS 路由场景）两种消息接收方式。
 */
export function createWsRemoteTransport(ws: WsConnectionLike): RemoteTransport {
  const pendingRequests = new Map<
    string,
    {
      resolve: (msg: TransportMessage) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const sessionListeners = new Set<(instanceId: string, sessionId: string, message: TransportMessage) => void>();

  function handleMessage(msg: TransportMessage): void {
    if (msg.request_id) {
      const pending = pendingRequests.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.request_id);
        pending.resolve(msg);
        return;
      }
    }

    if (msg.instance_id && msg.session_id) {
      for (const listener of sessionListeners) {
        listener(msg.instance_id, msg.session_id, msg);
      }
    }
  }

  // 劫持 onmessage（直连场景，acp-link 直接连接 transport 时使用）
  const originalOnMessage = ws.onmessage;
  ws.onmessage = (event: { data: string | Buffer }) => {
    if (originalOnMessage) originalOnMessage(event);

    const text = typeof event.data === "string" ? event.data : event.data.toString();
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const msg: TransportMessage = JSON.parse(line);
        handleMessage(msg);
      } catch {
        // 忽略格式错误
      }
    }
  };

  let requestIdCounter = 0;
  function nextRequestId(): string {
    requestIdCounter += 1;
    return `req_${Date.now()}_${requestIdCounter}`;
  }

  return {
    sendAndWait(message, options) {
      const requestId = message.request_id ?? nextRequestId();
      const timeout = options?.timeout ?? (message.type === "prepare" ? PREPARE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

      return new Promise<TransportMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`Transport request timed out: type=${message.type} request_id=${requestId}`));
        }, timeout);

        pendingRequests.set(requestId, { resolve, reject, timer });

        const outgoing: TransportMessage = { ...message, request_id: requestId };
        logger.info("→ remote sendAndWait", { type: outgoing.type, requestId, instanceId: outgoing.instance_id });
        ws.send(JSON.stringify(outgoing));
      });
    },

    onSessionMessage(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },

    send(message) {
      logger.info("→ remote send", { type: message.type, instanceId: message.instance_id });
      ws.send(JSON.stringify(message));
    },

    injectMessage(message) {
      logger.info("← remote inject", {
        type: message.type,
        requestId: message.request_id,
        instanceId: message.instance_id,
      });
      handleMessage(message);
    },
  };
}
