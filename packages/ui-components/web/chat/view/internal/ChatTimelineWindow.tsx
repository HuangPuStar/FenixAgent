/**
 * 时间线滑动窗口（渲染层）——只决定渲染哪些块。
 *
 * 数据侧零改动：`blocks` 由完整时间线构建，本组件只做切片；窗口外的条目照常接收流式 chunk 与广播
 * （数据进的是 Y.Doc 与投影，不是这里的状态）。窗口语义、常量与取舍见 `./chat-window.ts`，
 * 运行时（滚动触发与锚定补偿）见 `./use-chat-timeline-window.ts`。
 *
 * 为什么用 render prop 而不是把块到节点的映射搬进来：映射与 `ChatView` 的间距、活动链对齐补偿、
 * `EntryRenderer` 的 memo 边界是一份契约，搬走会让 `web/__tests__/chat-style-migration*.test.tsx`
 * 那批「源码级类名守卫」扫不到这批类名（守卫会静默失去覆盖）。这里只负责「切哪一段」。
 */

import type { ReactNode, Ref } from "react";
import type { ChatRenderBlock } from "../../lib/chat-render-layout";
import { type ChatTimelineWindowHandle, useChatTimelineWindow } from "./use-chat-timeline-window";

interface ChatTimelineWindowProps {
  /** 完整时间线的渲染块（窗口外的不进 DOM）。 */
  blocks: readonly ChatRenderBlock[];
  /** 是否有一轮进行中的响应：为真时窗口尾部锚定最新块，进行中的条目不会被滑出。 */
  live: boolean;
  /** 会话换代键：变化即回到最新窗口。 */
  sessionKey: string;
  /** 窗口命令出口（供提示词导航等调用方把窗口外的条目滑回来）。 */
  handleRef?: Ref<ChatTimelineWindowHandle> | undefined;
  /**
   * 渲染单个块。
   *
   * `blockIndex` 是块在完整列表里的下标（不是窗口内的相对下标）：`ChatView` 用它生成稳定 key，
   * 也用它判断「上一块是否为助手消息」的间距补偿，因此同一块在窗口任意位置渲染结果一致。
   */
  renderBlock: (block: ChatRenderBlock, blockIndex: number) => ReactNode;
}

/** 渲染当前窗口内的块（无包裹元素：块的 DOM 结构与非窗口化渲染逐字一致）。 */
export function ChatTimelineWindow({ blocks, live, sessionKey, handleRef, renderBlock }: ChatTimelineWindowProps) {
  const range = useChatTimelineWindow({ blocks, live, sessionKey, handleRef });
  return <>{blocks.slice(range.start, range.end).map((block, index) => renderBlock(block, range.start + index))}</>;
}
