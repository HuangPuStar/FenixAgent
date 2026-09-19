/**
 * 包内最小卡片事件通道（契约 + 默认实现）。
 *
 * 来源：方法签名复制自宿主 `apps/web/src/lib/card-renderer/emitter.ts` 的 `CardEventEmitter`
 * （`on` / `off` / `emit` / `destroy`），实现为本包按同一语义的最小重写 —— 源实现的类是宿主
 * 会话层代码，不能作为 `@fenix/*` 依赖引入。
 *
 * 纯化改动点：源 `Handler<T = unknown>` 泛型收敛为 `(payload: unknown) => void`，与宿主
 * `CardEventEmitter` 结构兼容，宿主可直接把自己的实例通过 `cardEmitter` prop 注入。
 * 宿主不注入时，`AssistantBubble` 用 `createCardEmitter()` 自建消息级实例保持源行为。
 */

/** 卡片事件通道的最小结构契约。 */
export interface CardEmitter {
  /** 订阅事件，返回取消订阅函数 */
  on(event: string, handler: (payload: unknown) => void): () => void;
  /** 取消订阅 */
  off(event: string, handler: (payload: unknown) => void): void;
  /** 发送事件 */
  emit(event: string, payload?: unknown): void;
  /** 清理所有订阅 */
  destroy(): void;
}

/** 创建包内最小事件通道实例，语义与宿主 `CardEventEmitter` 一致（消息级隔离，卸载即清理）。 */
export function createCardEmitter(): CardEmitter {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set<(payload: unknown) => void>();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
    },
    emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    destroy() {
      handlers.clear();
    },
  };
}
