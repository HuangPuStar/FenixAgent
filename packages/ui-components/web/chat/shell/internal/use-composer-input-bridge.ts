import { useCallback, useRef } from "react";
import type { ComposerExternalEvent, ComposerExternalSubscribe } from "../../composer/composer-effects";

/**
 * 把包内产生的输入岛外部事件并入宿主注入的订阅通道。
 *
 * 背景：源实现中「空状态建议提示词」与「消息引用」由 `ChatView` 经 window 自定义事件
 * （`chat:apply-suggested-prompt` / `chat:quote`）交回 `ChatComposer`，生产与消费都在 chat
 * 包内部。纯化把派发点改成回调、消费侧改成宿主注入的 `subscribeExternal`，若不在包内自闭合
 * 这条环路，两个动作会静默失效（点击无反应且无错误）。
 *
 * 设计取舍：
 * - 不新增第二条注入端口（如 `onApplySuggestedPrompt` 回调），而是把包内事件汇入同一个订阅
 *   通道：生产方与消费方仍以「事件」解耦，宿主注入的外部来源（如文件树引用）照旧生效，
 *   `ChatComposer` 只需一条订阅入口。
 * - 源实现用 `contextScope` 过滤 window 事件，因为 window 事件会在同一页面的多个会话实例间
 *   串扰（多个聊天面板同时挂载时）。本通道按 `ChatInterface` 实例作用域分发，
 *   跨实例串扰在结构上不可能，故包内事件不再做作用域过滤；宿主注入外部来源时仍自行保证
 *   事件归属的会话/环境正确（见 `chat/composer/composer-effects.ts` 的纯化说明）。
 */
export function useComposerInputBridge(hostSubscribe: ComposerExternalSubscribe | undefined): {
  /** 传给 `ChatComposer` 的订阅函数：同时接收包内事件与宿主注入来源。 */
  subscribe: ComposerExternalSubscribe;
  /** 派发包内输入岛事件（只应由包内事件处理器调用）。 */
  emit: (event: ComposerExternalEvent) => void;
} {
  // 已订阅的处理器集合由 ref 持有：`emit` 只依赖该 ref，身份稳定，从而不因订阅变化触发
  // `ChatComposer` 重新订阅（源实现对每个事件各订阅一次，重订阅会重置订阅关系）。
  const subscribersRef = useRef(new Set<(event: ComposerExternalEvent) => void>());

  const subscribe = useCallback<ComposerExternalSubscribe>(
    (handler) => {
      const subscribers = subscribersRef.current;
      subscribers.add(handler);
      const unsubscribeHost = hostSubscribe?.(handler);
      return () => {
        subscribers.delete(handler);
        unsubscribeHost?.();
      };
    },
    [hostSubscribe],
  );

  const emit = useCallback((event: ComposerExternalEvent) => {
    // 复制一份再遍历：处理器可能在事件处理中同步退订
    for (const handler of [...subscribersRef.current]) handler(event);
  }, []);

  return { subscribe, emit };
}
