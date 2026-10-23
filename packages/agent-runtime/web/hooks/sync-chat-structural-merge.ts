// packages/agent-runtime/web/hooks/sync-chat-structural-merge.ts
// 有序工具边界标记存在时的精确合并：同步投影已按标记切好段（entryId / entryId#N），
// 缺失段按序号落在第 N 个工具 run 之后；旧段保留 thought/error，只追加同步多出的正文。
//
// 该路径不依赖字符串启发式：段序号与工具 run 一一对应。任何不对称（序号不连续、
// run 数不足、正文无法前缀对齐）都返回 fallback，由调用方整条降级，绝不猜测位置。

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
  const edits: PlannedEdit[] = [];
  const insertions: PlannedInsertion[] = [];

  for (const segment of syncSegments) {
    const legacy = legacyById.get(segment.message.id);
    if (legacy !== undefined) {
      const legacyText = assistantText(legacy.message);
      if (segment.text.startsWith(legacyText)) {
        const extra = segment.text.slice(legacyText.length);
        if (extra.length > 0) {
          // 同步段跨过了后续旧段边界：说明中间 marker 缺失（例如缺 t2 导致 #1=BC）。
          // 不能把后续段正文追加到当前旧段，否则会与仍保留的后续段重复（ABCC）；整条降级。
          const laterTexts = input.legacySegments.filter(
            (candidate) => candidate.ordinal > legacy.ordinal && candidate.text.length > 0,
          );
          if (laterTexts.some((candidate) => extra.includes(candidate.text))) {
            return fallback("incomplete-markers");
          }
          edits.push({ segment: legacy, side: "suffix", text: extra });
        }
      } else if (!legacyText.startsWith(segment.text)) {
        // 同一分段两路正文互不为前缀：无法判断谁更完整，整条降级而不是拼接。
        return fallback("ambiguous-alignment");
      }
      continue;
    }

    // 缺段位置：边界标记记录了本段之前的最后一个工具 id（工具 run 取 run 的最后一个）。
    // 直接在该工具之后插入；缺失/未知 id 说明标记不完整，降级而不是猜 run 切分。
    let beforeIndex: number;
    if (segment.ordinal === 0) {
      beforeIndex = tools[0] ?? input.blockStart;
    } else {
      const boundaryToolId = segment.message.entryBoundaryToolId;
      if (typeof boundaryToolId !== "string" || boundaryToolId.length === 0) {
        return fallback("incomplete-markers");
      }
      const toolIndex = input.legacy.findIndex(
        (message, index) =>
          index >= input.blockStart &&
          index <= input.blockEnd &&
          message.type === "tool_call" &&
          message.id === boundaryToolId,
      );
      if (toolIndex < 0) return fallback("incomplete-markers");
      beforeIndex = toolIndex + 1;
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
