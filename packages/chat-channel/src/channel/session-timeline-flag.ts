// packages/chat-channel/src/channel/session-timeline-flag.ts
// 连接建立时把「当前投影是否已有时间线」写入 Session Doc：客户端据此区分
// 「已有空会话」与「历史回放尚未开始」，无需 1.5s 计时兜底。

import type * as Y from "yjs";

/** 只写一个布尔标记；投影结构缺失时静默跳过（防御性，不阻塞连接）。 */
export function markSessionTimelineEmpty(ydoc: Y.Doc, empty: boolean): void {
  const session = ydoc.getMap("root").get("session");
  if (session === undefined || session === null) return;
  (session as Y.Map<unknown>).set("timelineEmpty", empty);
}
