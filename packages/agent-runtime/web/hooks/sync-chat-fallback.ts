import type { AssistantMessage, EntrySegment } from "./sync-chat-merge-types";

/** 按原 chunk 顺序对齐；只接受完整有序覆盖，不用重复子串猜工具位置。 */
function alignedOffsets(parts: readonly string[], text: string): number[] | null {
  const offsets: number[] = [];
  let cursor = 0;
  for (const part of parts) {
    const offset = text.indexOf(part, cursor);
    if (offset < 0) return null;
    offsets.push(offset);
    cursor = offset + part.length;
  }
  return offsets;
}

/** 旧侧超前时保留其完整正文；同步投影的较短文本不能覆盖已显示文本。 */
export function fallbackText(segments: readonly EntrySegment[], syncText: string): string {
  const oldParts = segments.flatMap((segment) =>
    segment.message.chunks.filter((chunk) => chunk.type === "message").map((chunk) => chunk.text),
  );
  const oldText = oldParts.join("");
  if (alignedOffsets(oldParts, syncText) !== null) return syncText;
  if (alignedOffsets([...syncText], oldText) !== null) return oldText;
  // 旧段乱序/两路歧义仍按同步正文整条降级，不把乱序文本再追加一遍。
  return syncText;
}

/** 非文本/错误仍留在原助手段，缺失文本只在原 message chunk 的槽位补齐。 */
export function fallbackSegments(segments: readonly EntrySegment[], text: string): readonly AssistantMessage[] | null {
  if (
    !segments.some(
      ({ message }) => message.error !== undefined || message.chunks.some((chunk) => chunk.type !== "message"),
    )
  ) {
    return null;
  }
  const parts = segments.flatMap(({ message }) =>
    message.chunks.filter((chunk) => chunk.type === "message").map((chunk) => chunk.text),
  );
  const offsets = alignedOffsets(parts, text);
  let partIndex = 0;
  let cursor = 0;
  let inserted = false;
  return segments.map(({ message }, segmentIndex) => {
    const chunks = message.chunks.map((chunk) => {
      if (chunk.type !== "message") return chunk;
      if (offsets === null) {
        const next = { ...chunk, text: inserted ? "" : text };
        inserted = true;
        return next;
      }
      const end = offsets[partIndex]! + chunk.text.length;
      const next = { ...chunk, text: text.slice(cursor, partIndex === parts.length - 1 ? text.length : end) };
      cursor = end;
      partIndex += 1;
      return next;
    });
    if (parts.length === 0 && segmentIndex === 0) chunks.push({ type: "message", text });
    return { ...message, chunks };
  });
}
