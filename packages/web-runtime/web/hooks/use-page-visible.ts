import { createContext, useContext } from "react";

/**
 * ChatPageVisibleContext — 由 ChatArea 提供，标识当前聊天页面是否对用户可见。
 * 默认 true，确保在非 ChatArea 场景下行为正常。
 */
export const ChatPageVisibleContext = createContext<boolean>(true);

/** useChatPageVisible — 读取当前聊天页面是否对用户可见。 */
export function useChatPageVisible(): boolean {
  return useContext(ChatPageVisibleContext);
}
