// packages/agent-runtime/web/hooks/sync-chat-merge-types.ts
// 新旧双路消息合并的共享类型与文本原语：只含数据结构与纯函数，不依赖合并策略。

import type { StructuredMessage } from "@fenix/chat-channel";

export type AssistantMessage = Extract<StructuredMessage, { type: "assistant_message" }>;
export type AssistantChunk = AssistantMessage["chunks"][number];

/** 旧投影的一个助手文本段：`index` 是 legacy 数组下标，`ordinal` 是 `entryId#N` 的 N。 */
export interface EntrySegment {
  readonly message: AssistantMessage;
  readonly index: number;
  readonly text: string;
  readonly ordinal: number;
}

export interface PlannedInsertion {
  readonly beforeIndex: number;
  readonly ordinal: number;
  readonly text: string;
  readonly reference: EntrySegment;
}

export interface PlannedEdit {
  readonly segment: EntrySegment;
  readonly side: "prefix" | "suffix";
  readonly text: string;
}

/** 降级原因：旧数据没有有序工具标记，或边界无法唯一判定时显式上报。 */
export type MergeDegradeReason =
  | "markers-missing"
  | "incomplete-markers"
  | "ambiguous-alignment"
  | "boundary-count-mismatch"
  | "trailing-tools-without-markers"
  | "unordered-legacy"
  | "missing-text-anchor";

export interface MergeDegradation {
  readonly entryId: string;
  readonly reason: MergeDegradeReason;
}

/** 助手正文（只取 message chunk，thought 不进入正文）。 */
export function assistantText(message: AssistantMessage): string {
  return message.chunks
    .filter((chunk) => chunk.type === "message")
    .map((chunk) => chunk.text)
    .join("");
}

/** 在段首合并正文：保留 thought 块位置，只改第一条 message chunk。 */
export function prependSegmentText(message: AssistantMessage, text: string): AssistantMessage {
  if (text.length === 0) return message;
  const chunks = message.chunks.map((chunk) => ({ ...chunk }));
  const index = chunks.findIndex((chunk) => chunk.type === "message");
  const target = index >= 0 ? chunks[index] : undefined;
  if (target !== undefined && target.type === "message") {
    chunks[index] = { ...target, text: `${text}${target.text}` };
  } else {
    const chunk: AssistantChunk = { type: "message", text };
    chunks.unshift(chunk);
  }
  return { ...message, chunks };
}

/** 在段尾合并正文：与同步投影的拼接顺序一致，保留其后可能存在的 thought 块。 */
export function appendSegmentText(message: AssistantMessage, text: string): AssistantMessage {
  if (text.length === 0) return message;
  const chunks = message.chunks.map((chunk) => ({ ...chunk }));
  let lastMessageIndex = -1;
  for (let index = 0; index < chunks.length; index += 1) {
    if (chunks[index]?.type === "message") lastMessageIndex = index;
  }
  const target = lastMessageIndex >= 0 ? chunks[lastMessageIndex] : undefined;
  if (target !== undefined && target.type === "message") {
    chunks[lastMessageIndex] = { ...target, text: `${target.text}${text}` };
  } else {
    const chunk: AssistantChunk = { type: "message", text };
    chunks.push(chunk);
  }
  return { ...message, chunks };
}
