// packages/agent-runtime/web/hooks/sync-chat-structural-merge.ts
// 有序工具边界标记存在时按 entry 内工具 occurrence 合并；无法校验时显式降级。
// 正文段序号与工具 ordinal 不等价：工具开头、连续 run 均不产生空正文段。

import type { StructuredMessage } from "@fenix/chat-channel";
import type {
  AssistantMessage,
  EntrySegment,
  MergeDegradeReason,
  PlannedEdit,
  PlannedInsertion,
} from "./sync-chat-merge-types";

export interface StructuralPlan {
  readonly mode: "inject" | "fallback";
  readonly edits: readonly PlannedEdit[];
  readonly insertions: readonly PlannedInsertion[];
  readonly reason: MergeDegradeReason | null;
}

interface AssistantSegment {
  readonly message: AssistantMessage;
  readonly ordinal: number;
  readonly text: string;
}

function assistantText(message: AssistantMessage): string {
  return message.chunks
    .filter((chunk) => chunk.type === "message")
    .map((chunk) => chunk.text)
    .join("");
}

/** 段序号：入口 id 为 0，`base#N` 为 N；入口 id 自身可能含 `#`。 */
function ordinalOf(id: string, base: string): number {
  if (id === base) return 0;
  if (!id.startsWith(`${base}#`)) return 0;
  const suffix = id.slice(base.length + 1);
  return /^\d+$/.test(suffix) ? Number(suffix) : 0;
}

/** 范围 [from, to] 内的工具消息下标。 */
function toolIndicesIn(legacy: readonly StructuredMessage[], from: number, to: number): number[] {
  const indices: number[] = [];
  for (let index = Math.max(0, from); index <= to && index < legacy.length; index += 1) {
    if (legacy[index]?.type === "tool_call") indices.push(index);
  }
  return indices;
}

/**
 * 生成精确合并计划。
 *
 * 入参的 `syncMessages` 是同一 base 的同步分段（base / base#1 / …）；调用方保证 legacy
 * 至少有一个文本段作为锚点，否则应走“无锚点降级”。
 */
export function planStructuralGroup(input: {
  readonly legacy: readonly StructuredMessage[];
  readonly base: string;
  readonly legacySegments: readonly EntrySegment[];
  readonly syncMessages: readonly AssistantMessage[];
  readonly blockStart: number;
  readonly blockEnd: number;
}): StructuralPlan {
  const fallback = (reason: MergeDegradeReason): StructuralPlan => ({
    mode: "fallback",
    edits: [],
    insertions: [],
    reason,
  });

  const syncSegments: AssistantSegment[] = [];
  for (const message of input.syncMessages) {
    syncSegments.push({ message, ordinal: ordinalOf(message.id, input.base), text: assistantText(message) });
  }
  syncSegments.sort((left, right) => left.ordinal - right.ordinal);
  for (let index = 1; index < syncSegments.length; index += 1) {
    // 段序号必须连续：缺一个序号说明标记/投影不完整，无法把段与工具边界一一对应。
    if (syncSegments[index]!.ordinal !== syncSegments[index - 1]!.ordinal + 1) {
      return fallback("boundary-count-mismatch");
    }
  }
  if (input.legacySegments.length === 0) return fallback("missing-text-anchor");
  if (input.syncMessages.some((message) => message.entryBoundaryIssue === true)) {
    return fallback("incomplete-markers");
  }

  const legacyById = new Map(input.legacySegments.map((segment) => [segment.message.id, segment]));
  const tools = toolIndicesIn(input.legacy, input.blockStart, input.blockEnd);
  const legacyMaxOrdinal = input.legacySegments.reduce((max, segment) => Math.max(max, segment.ordinal), 0);
  const syncMaxOrdinal = syncSegments[syncSegments.length - 1]?.ordinal ?? 0;
  const boundaryCount = input.syncMessages.reduce((max, message) => Math.max(max, message.entryBoundaryCount ?? 0), 0);
  const lastAnchorIndex = Math.max(...input.legacySegments.map((segment) => segment.index));
  const anchoredTools = tools.filter((index) => index < lastAnchorIndex);
  if (
    boundaryCount < legacyMaxOrdinal ||
    syncMaxOrdinal < legacyMaxOrdinal ||
    (input.syncMessages.some((message) => message.entryBoundaryCount !== undefined) &&
      anchoredTools.length > boundaryCount)
  ) {
    return fallback("incomplete-markers");
  }
  const edits: PlannedEdit[] = [];
  const insertions: PlannedInsertion[] = [];

  for (const segment of syncSegments) {
    const markerOrdinal = segment.message.entryBoundaryMarkerOrdinal;
    const boundaryToolId = segment.message.entryBoundaryToolId;
    const matchingTools = tools.filter((index) => input.legacy[index]?.id === boundaryToolId);
    const boundaryIndex =
      typeof markerOrdinal === "number"
        ? tools[markerOrdinal]
        : matchingTools.length === 1
          ? matchingTools[0]
          : undefined;
    if (
      typeof boundaryToolId === "string" &&
      boundaryToolId.length > 0 &&
      (boundaryIndex === undefined || input.legacy[boundaryIndex]?.id !== boundaryToolId)
    ) {
      return fallback("incomplete-markers");
    }
    const legacy = legacyById.get(segment.message.id);
    if (legacy !== undefined) {
      const legacyText = assistantText(legacy.message);
      if (segment.text.startsWith(legacyText)) {
        const extra = segment.text.slice(legacyText.length);
        if (extra.length > 0) {
          // 旧格式缺 occurrence 元数据时，文本重叠只能作为“不完整”的证据，不能据此精确落位。
          const laterTexts = input.legacySegments.filter(
            (candidate) => candidate.ordinal > legacy.ordinal && candidate.text.length > 0,
          );
          if (
            typeof markerOrdinal !== "number" &&
            laterTexts.some((candidate) => extra.includes(candidate.text) || candidate.text.includes(extra))
          )
            return fallback("incomplete-markers");
          edits.push({ segment: legacy, side: "suffix", text: extra });
        }
      } else if (!legacyText.startsWith(segment.text)) {
        // 同一分段两路正文互不为前缀：无法判断谁更完整，整条降级而不是拼接。
        return fallback("ambiguous-alignment");
      }
      continue;
    }

    // 工具 occurrence ordinal 在本 entry 块内定位 run 尾，不能按同名 id 取第一条。
    let beforeIndex: number;
    if (boundaryIndex !== undefined) {
      beforeIndex = boundaryIndex + 1;
    } else if (segment.ordinal === 0 && !boundaryToolId) {
      beforeIndex = tools[0] ?? input.blockStart;
    } else {
      return fallback("incomplete-markers");
    }
    const reference =
      input.legacySegments.find((candidate) => candidate.ordinal >= segment.ordinal) ??
      input.legacySegments[input.legacySegments.length - 1]!;
    insertions.push({
      beforeIndex,
      ordinal: segment.ordinal,
      text: segment.text,
      reference,
    });
  }

  return { mode: "inject", edits, insertions, reason: null };
}
