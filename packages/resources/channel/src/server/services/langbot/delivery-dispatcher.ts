import { error as logError } from "@fenix/logger";
import type { ImChannelConversationRepository } from "../../repositories/im-channel-conversation";
import type { ImChannelEventRepository } from "../../repositories/im-channel-event";

/**
 * 进程内 IM 订阅通知派发器（规格 §4.6 / §6.1.7-8）。
 *
 * 通知是 K 型事件：只有订阅流存在时才能写 `notifications/resources/updated`。没有订阅时事件必须保持
 * `received` 并按 1s/2s/4s…（上限 30s）退避重试，等实例连接建立后补发；平台不轮询 Agent，也不另建消息队列。
 *
 * 三个边界：
 * 1. 通知只带资源 URI，不带正文、发送者或 token：正文只能由 Agent 通过 `resources/read` 读取。
 * 2. 订阅表按 conversation 隔离，跨聊天不共享任何流。
 * 3. 只保证进程内：重启后遗留事件由启动维护标记失败，不重放（规格 §6.3）。
 */

/** 订阅通知的资源 URI；与 MCP `resources/read` 的 URI 是同一个字符串。 */
export const IM_INBOX_RESOURCE_URI = "im://inbox" as const;

/** 订阅流的最小协议面；具体传输（MCP streamable-http）由后续层实现。 */
export interface ImSubscriptionSink {
  notifyResourceUpdated(input: { readonly uri: typeof IM_INBOX_RESOURCE_URI }): void | Promise<void>;
}

export interface DeliveryDispatcherDeps {
  readonly events: ImChannelEventRepository;
  readonly conversations: ImChannelConversationRepository;
  readonly retryBaseMs?: number;
  readonly retryMaxMs?: number;
  readonly now?: () => Date;
  /** 测试注入点：控制退避节奏，不引入真实等待。 */
  readonly timer?: DeliveryTimer;
}

/** 退避定时器的窄接口；默认实现使用全局 `setTimeout` 并 `unref`。 */
export interface DeliveryTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DeliveryDispatcher {
  /** 注册订阅流；返回取消函数。注册时立即补发该会话所有 `received` 事件。 */
  subscribe(conversationId: string, sink: ImSubscriptionSink): () => void;
  /** 入站事务提交后调用：有订阅立即投递，否则进入退避重试。 */
  enqueue(input: { eventId: string; conversationId: string }): void;
  /** 停止全部重试定时器并清空订阅；进程关闭与测试复位使用。 */
  stop(): void;
  /** 诊断用：某会话当前订阅流数量。 */
  subscriptionCount(conversationId: string): number;
}

const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_RETRY_MAX_MS = 30_000;

const defaultTimer: DeliveryTimer = {
  setTimeout(callback, delayMs) {
    const handle: unknown = setTimeout(callback, delayMs);
    // Bun 与 Node 的 timer 句柄都带 unref；DOM 类型下是 number，故按结构收窄而不是 `as any`。
    (handle as { unref?: () => void }).unref?.();
    return handle;
  },
  clearTimeout(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createDeliveryDispatcher(deps: DeliveryDispatcherDeps): DeliveryDispatcher {
  const retryBaseMs = deps.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
  const retryMaxMs = deps.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
  const now = deps.now ?? (() => new Date());
  const timer = deps.timer ?? defaultTimer;

  const sinks = new Map<string, Set<ImSubscriptionSink>>();
  const retryHandles = new Map<string, unknown>();
  /** 正在尝试投递的事件：防止订阅补发与重试定时器并发写同一条通知。 */
  const inFlight = new Set<string>();
  let stopped = false;

  function clearRetry(eventId: string): void {
    const handle = retryHandles.get(eventId);
    if (handle === undefined) return;
    timer.clearTimeout(handle);
    retryHandles.delete(eventId);
  }

  function scheduleRetry(eventId: string, conversationId: string, attemptCount: number): void {
    if (stopped) return;
    clearRetry(eventId);
    // 1s → 2s → 4s …；上限 30s，避免订阅长期缺失时把重试打成忙等。
    const delayMs = Math.min(retryBaseMs * 2 ** attemptCount, retryMaxMs);
    const handle = timer.setTimeout(() => {
      retryHandles.delete(eventId);
      // 直接进入下一次尝试并带上递增计数：经 enqueue 会把退避重置回 1s。
      void attempt(eventId, conversationId, attemptCount + 1);
    }, delayMs);
    retryHandles.set(eventId, handle);
  }

  async function attempt(eventId: string, conversationId: string, attemptCount: number): Promise<void> {
    if (stopped) return;
    if (inFlight.has(eventId)) return;
    inFlight.add(eventId);
    try {
      const event = await deps.events.findById({ eventId });
      // 已被重启维护标记失败或已被投递：重试没有意义。
      if (event?.status !== "received") return;

      const subscribers = sinks.get(conversationId);
      if (!subscribers || subscribers.size === 0) {
        scheduleRetry(eventId, conversationId, attemptCount);
        return;
      }

      let delivered = false;
      for (const sink of subscribers) {
        try {
          await sink.notifyResourceUpdated({ uri: IM_INBOX_RESOURCE_URI });
          delivered = true;
        } catch (error) {
          // 单条订阅流故障不隔离其它流：同一 conversation 可能有重连中的旧连接。
          logError("IM 订阅通知写入失败", error instanceof Error ? error : undefined);
        }
      }

      if (!delivered) {
        await deps.events.recordAttempt({ eventId, lastError: "notification_failed" });
        scheduleRetry(eventId, conversationId, attemptCount);
        return;
      }

      try {
        await deps.events.markDelivered({ eventId, deliveryVia: "notification", at: now() });
      } catch (error) {
        // 通知已经发出，重试会重复唤醒 Agent；状态由启动维护收口，不在投递路径上二次发送。
        logError("IM 事件投递状态写入失败", error instanceof Error ? error : undefined);
      }
    } catch (error) {
      // 读事件失败（例如 DB 短暂不可用）按可重试处理，错误只留在日志。
      logError("IM 事件投递失败", error instanceof Error ? error : undefined);
      scheduleRetry(eventId, conversationId, attemptCount);
    } finally {
      inFlight.delete(eventId);
    }
  }

  function enqueue(input: { eventId: string; conversationId: string }): void {
    if (stopped) return;
    clearRetry(input.eventId);
    void attempt(input.eventId, input.conversationId, 0);
  }

  async function flush(conversationId: string): Promise<void> {
    const conversation = await deps.conversations.findById({ conversationId });
    if (!conversation) return;
    const pending = await deps.events.findUndeliveredByChat({
      channelId: conversation.channelId,
      chatType: conversation.chatType,
      chatId: conversation.chatId,
      limit: 100,
    });
    for (const event of pending) enqueue({ eventId: event.id, conversationId });
  }

  return {
    subscribe(conversationId, sink) {
      if (stopped) return () => undefined;
      let subscribers = sinks.get(conversationId);
      if (!subscribers) {
        subscribers = new Set();
        sinks.set(conversationId, subscribers);
      }
      subscribers.add(sink);
      // 订阅流注册时补发积压事件；失败只记日志，事件继续留在 received 等下一次退避。
      void flush(conversationId).catch((error) => {
        logError("IM 订阅补发失败", error instanceof Error ? error : undefined);
      });
      return () => {
        const current = sinks.get(conversationId);
        if (!current) return;
        current.delete(sink);
        if (current.size === 0) sinks.delete(conversationId);
      };
    },

    enqueue,

    stop() {
      stopped = true;
      for (const handle of retryHandles.values()) timer.clearTimeout(handle);
      retryHandles.clear();
      inFlight.clear();
      sinks.clear();
    },

    subscriptionCount(conversationId) {
      return sinks.get(conversationId)?.size ?? 0;
    },
  };
}
