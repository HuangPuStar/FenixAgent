import { createContext, useContext } from "react";
import type { CardEventEmitter } from "./emitter";

/**
 * 消息粒度的 emitter 上下文。
 * 由 AssistantBubble 在渲染助手消息时注入，同一消息内的所有卡片组件共享同一 emitter 实例。
 */
export const MessageEmitterContext = createContext<CardEventEmitter | null>(null);

/**
 * 卡片组件使用此 hook 发送事件。
 * 若不在 MessageEmitterContext 内（例如组件被独立使用），返回 noop 函数，不抛错。
 *
 * 用法：
 * ```tsx
 * function SitesCard({ url }: { url: string }) {
 *   const emit = useCardEmit();
 *   useEffect(() => { emit("render", { url }); }, []);
 *   return <div onClick={() => emit("open", { url })}>...</div>;
 * }
 * ```
 */
export function useCardEmit() {
  const emitter = useContext(MessageEmitterContext);
  if (!emitter) {
    return (_event: string, _payload?: unknown) => {
      // noop — 组件在 Provider 外部被使用，安全降级
    };
  }
  return (event: string, payload?: unknown) => {
    emitter.emit(event, payload);
  };
}
