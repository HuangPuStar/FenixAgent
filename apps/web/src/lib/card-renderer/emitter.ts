type Handler<T = unknown> = (payload: T) => void;

/**
 * 轻量级事件发射器，用于卡片组件与外部代码通信。
 * 每个 AssistantBubble 消息创建独立实例，消息级别隔离。
 */
export class CardEventEmitter {
  private handlers = new Map<string, Set<Handler>>();

  /** 订阅事件，返回取消订阅函数 */
  on(event: string, handler: Handler): () => void {
    if (!this.handlers.has(event)) {
      this.handlers.set(event, new Set());
    }
    this.handlers.get(event)!.add(handler);
    return () => this.off(event, handler);
  }

  /** 取消订阅 */
  off(event: string, handler: Handler): void {
    this.handlers.get(event)?.delete(handler);
  }

  /** 发送事件 */
  emit(event: string, payload?: unknown): void {
    // biome-ignore lint/suspicious/useIterableCallbackReturn: handler returns void, forEach is used for side effects
    this.handlers.get(event)?.forEach((handler) => handler(payload));
  }

  /** 清理所有订阅 */
  destroy(): void {
    this.handlers.clear();
  }
}
