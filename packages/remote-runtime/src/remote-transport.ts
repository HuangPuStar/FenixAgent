import { createLogger } from "@fenix/logger";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

const logger = createLogger("remote-transport");

// ── 协议消息类型 ──────────────────────────────────

export interface TransportMessage {
  type: string;
  request_id?: string;
  instance_id?: string;
  instance_uid?: string;
  runtime_generation?: number;
  server_epoch?: string;
  protocol_version?: number;
  clean_slate?: boolean;
  session_id?: string;
  launch_spec?: AgentLaunchSpec;
  engine_type?: string;
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
  /** 连接断开时立即拒绝全部 pending lifecycle 请求。 */
  close(reason?: string): void;
  /** 外部路由注入收到的消息（由 RCS acp-ws-handler 调用，替代 onmessage 劫持） */
  injectMessage(message: TransportMessage): void;
  /**
   * 同 epoch 传输重连：切换到新连接。
   *
   * 保留 session listener（在途 turn 继续观察）与断连期间到达的 stop 意图，
   * 已发送但结果未知的请求不会重放。
   */
  rebind?(ws: WsConnectionLike): void;
  /**
   * 传输暂时断连：拒绝结果未知的在途请求，但保留 session listener 等待 rebind。
   *
   * 终态清理仍走 `close`，它会同时释放 listener。
   */
  disconnect?(reason?: string): void;
}

// ── 默认超时 ──────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const PREPARE_TIMEOUT_MS = 60_000;

// ── 基于 WsConnection 的生产 Transport ──────────────────────────

export interface WsConnectionLike {
  readyState: number;
  send(data: string): void;
  onmessage?: ((event: { data: string | Buffer }) => void) | null;
}

/**
 * 创建基于 WS 连接的 RemoteTransport。
 * 支持 onmessage 劫持（直连场景）和 injectMessage（RCS 路由场景）两种消息接收方式。
 */
export function createWsRemoteTransport(initialWs: WsConnectionLike): RemoteTransport {
  const pendingRequests = new Map<
    string,
    {
      resolve: (msg: TransportMessage) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      fence?: { instanceUid: string; runtimeGeneration: number; serverEpoch: string };
      message: TransportMessage;
    }
  >();
  const sessionListeners = new Set<(instanceId: string, sessionId: string, message: TransportMessage) => void>();
  // 断连期间到达或结果未知的 stop 意图：stop 是幂等终止意图，重连后补发不会重复外部副作用。
  // 其他 lifecycle 请求一律失败，避免「结果未知却重放」。
  const deferredStops: Array<{
    message: TransportMessage;
    resolve: (msg: TransportMessage) => void;
    reject: (err: Error) => void;
  }> = [];
  let ws: WsConnectionLike | null = initialWs;
  let connected = true;

  function handleMessage(msg: TransportMessage): void {
    if (msg.request_id) {
      const pending = pendingRequests.get(msg.request_id);
      if (pending) {
        if (
          pending.fence &&
          (msg.instance_uid !== pending.fence.instanceUid ||
            msg.runtime_generation !== pending.fence.runtimeGeneration ||
            msg.server_epoch !== pending.fence.serverEpoch)
        ) {
          logger.warn("Rejected stale remote result", { type: msg.type, requestId: msg.request_id });
          return;
        }
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
  const originalOnMessage = initialWs.onmessage;
  if ("onmessage" in initialWs)
    initialWs.onmessage = (event: { data: string | Buffer }) => {
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

  function dispatch(
    message: TransportMessage,
    resolve: (msg: TransportMessage) => void,
    reject: (err: Error) => void,
    options?: TransportSendOptions,
  ): void {
    const target = ws;
    if (!connected || !target) {
      reject(new Error(`Remote transport is disconnected: type=${message.type}`));
      return;
    }
    const requestId = message.request_id ?? nextRequestId();
    const timeout = options?.timeout ?? (message.type === "prepare" ? PREPARE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    const timer = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error(`Transport request timed out: type=${message.type} request_id=${requestId}`));
    }, timeout);

    const fence =
      typeof message.instance_uid === "string" &&
      typeof message.runtime_generation === "number" &&
      typeof message.server_epoch === "string"
        ? {
            instanceUid: message.instance_uid,
            runtimeGeneration: message.runtime_generation,
            serverEpoch: message.server_epoch,
          }
        : undefined;
    pendingRequests.set(requestId, { resolve, reject, timer, fence, message });

    const outgoing: TransportMessage = { ...message, request_id: requestId };
    logger.info("→ remote sendAndWait", { type: outgoing.type, requestId, instanceId: outgoing.instance_id });
    target.send(JSON.stringify(outgoing));
  }

  /** 断连：结果未知的 stop 延后到重连补发，其余请求立即失败。 */
  function rejectAfterDisconnect(reason: string): void {
    for (const [requestId, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pendingRequests.delete(requestId);
      if (pending.message.type === "stop") {
        deferredStops.push({ message: pending.message, resolve: pending.resolve, reject: pending.reject });
      } else {
        pending.reject(new Error(reason));
      }
    }
  }

  return {
    sendAndWait(message, options) {
      if (!connected) {
        if (message.type === "stop") {
          return new Promise<TransportMessage>((resolve, reject) => {
            deferredStops.push({ message, resolve, reject });
          });
        }
        return Promise.reject(new Error(`Remote transport is disconnected: type=${message.type}`));
      }
      return new Promise<TransportMessage>((resolve, reject) => dispatch(message, resolve, reject, options));
    },

    onSessionMessage(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },

    send(message) {
      // 断连窗口只保留观察与状态，不缓存待重发的下行消息（prompt 结果未知，禁止重放）。
      if (!connected || !ws) {
        logger.debug("→ remote send dropped while disconnected", {
          type: message.type,
          instanceId: message.instance_id,
        });
        return;
      }
      logger.info("→ remote send", { type: message.type, instanceId: message.instance_id });
      ws.send(JSON.stringify(message));
    },

    close(reason = "Remote transport closed") {
      connected = false;
      ws = null;
      rejectAfterDisconnect(reason);
      for (const deferred of deferredStops.splice(0)) deferred.reject(new Error(reason));
      sessionListeners.clear();
    },

    disconnect(reason = "Remote transport disconnected") {
      if (!connected) return;
      connected = false;
      ws = null;
      rejectAfterDisconnect(reason);
    },

    rebind(nextWs) {
      ws = nextWs;
      connected = true;
      for (const deferred of deferredStops.splice(0)) dispatch(deferred.message, deferred.resolve, deferred.reject);
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
