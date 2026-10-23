// packages/agent-runtime/web/hooks/sync-chat-heuristic-merge.ts
// 旧数据（没有有序工具边界标记）的保守合并：只处理单缺口单工具等可判定场景；
// 多缺段、尾段跨工具、重复子串等一律返回 fallback，由编排层显式降级。

import type { StructuredMessage } from "@fenix/chat-channel";
import type { EntrySegment, MergeDegradeReason, PlannedEdit, PlannedInsertion } from "./sync-chat-merge-types";

export interface GroupPlan {
  readonly mode: "skip" | "inject" | "fallback";
  readonly insertions: readonly PlannedInsertion[];
  readonly edits: readonly PlannedEdit[];
  readonly reason: MergeDegradeReason | null;
}

interface SegmentMatch {
  readonly segment: EntrySegment;
  readonly start: number;
  readonly end: number;
}

/**
 * 把旧分段按出现顺序对齐到同步整段文本。
 *
 * 同一段文本在后续位置再次出现时，无法确定哪一次才是真实段边界；继续贪心匹配会把
 * 重复子串错误拆到工具两侧，必须显式降级（返回 ambiguous）。
 */
function alignSegmentsToSyncText(
  syncText: string,
  segments: readonly EntrySegment[],
): { matches: SegmentMatch[]; gaps: Array<{ start: number; end: number }>; ambiguous: boolean } {
  const matches: SegmentMatch[] = [];
  let cursor = 0;
  let ambiguous = false;
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const position = syncText.indexOf(segment.text, cursor);
    if (position < 0) continue;
    const nextOccurrence = syncText.indexOf(segment.text, position + 1);
    if (matches.length === 0) {
      // 首个已知段：序号 0 必须从文本起点开始，起点即锚点，后续同名子串属于正文；
      // 序号 >0 表示前面还有缺失段，重复出现时无法确定哪一次才是首个已知段。
      if (segment.ordinal === 0) {
        if (position !== 0) {
          ambiguous = true;
          break;
        }
      } else if (nextOccurrence >= 0) {
        ambiguous = true;
        break;
      }
    } else if (nextOccurrence >= 0) {
      ambiguous = true;
      break;
    }
    matches.push({ segment, start: position, end: position + segment.text.length });
    cursor = position + segment.text.length;
  }
  if (ambiguous) return { matches: [], gaps: [], ambiguous: true };
  const gaps: Array<{ start: number; end: number }> = [];
  let coveredUntil = 0;
  for (const match of matches) {
    if (match.start > coveredUntil) gaps.push({ start: coveredUntil, end: match.start });
    coveredUntil = match.end;
  }
  if (coveredUntil < syncText.length) gaps.push({ start: coveredUntil, end: syncText.length });
  return { matches, gaps, ambiguous: false };
}

/** 范围 [from, to] 内的工具消息下标；from > to 返回空。 */
function toolIndicesIn(legacy: readonly StructuredMessage[], from: number, to: number): number[] {
  const indices: number[] = [];
  for (let index = Math.max(0, from); index <= to && index < legacy.length; index += 1) {
    if (legacy[index]?.type === "tool_call") indices.push(index);
  }
  return indices;
}

/**
 * 判定一条 entry 的缺口如何落位。
 *
 * 只在「单缺口 + 单工具」时给出位置；多缺段/多工具/尾段跨工具/重复子串均返回 fallback，
 * 由调用方整条退化为新投影单条消息并上报降级。
 */
export function planGroup(
  segments: readonly EntrySegment[],
  legacy: readonly StructuredMessage[],
  syncText: string,
  blockStart: number,
  blockEnd: number,
): GroupPlan {
  const { matches, gaps, ambiguous } = alignSegmentsToSyncText(syncText, segments);
  const insertions: PlannedInsertion[] = [];
  const edits: PlannedEdit[] = [];
  if (ambiguous) return { mode: "fallback", insertions: [], edits: [], reason: "ambiguous-alignment" };

  const fallback = (reason: MergeDegradeReason): GroupPlan => ({
    mode: "fallback",
    insertions: [],
    edits: [],
    reason,
  });

  // 没有任何已知段能对齐：只能处理“同步是旧文本前缀/后缀”的单调关系，其余一律降级。
  if (matches.length === 0) {
    const legacyText = segments.map((segment) => segment.text).join("");
    if (legacyText.startsWith(syncText)) return { mode: "inject", insertions, edits, reason: null };
    if (!syncText.startsWith(legacyText)) return fallback("missing-text-anchor");
  }

  // 缺口从左到右处理：每个缺口只会落在下一个已知段之前，或条目末尾。
  for (const gap of gaps) {
    const gapText = syncText.slice(gap.start, gap.end);
    if (gapText.length === 0) continue;
    const following = matches.find((match) => match.start >= gap.end);
    const preceding = [...matches].reverse().find((match) => match.end <= gap.start);

    if (gapText.trim().length === 0) {
      // 纯空白不制造空消息：并入相邻已知段，正文空白不丢失。
      if (preceding !== undefined) edits.push({ segment: preceding.segment, side: "suffix", text: gapText });
      else if (following !== undefined) edits.push({ segment: following.segment, side: "prefix", text: gapText });
      continue;
    }

    if (following === undefined) {
      // 尾段：旧投影没有更多段可锚定；其后存在工具时位置不可判定，必须显式降级。
      const lastSegment = preceding?.segment ?? segments[segments.length - 1];
      if (lastSegment === undefined) return fallback("missing-text-anchor");
      const tools = toolIndicesIn(legacy, lastSegment.index + 1, blockEnd);
      if (tools.length > 0) return fallback("trailing-tools-without-markers");
      edits.push({ segment: lastSegment, side: "suffix", text: gapText });
      continue;
    }

    if (preceding === undefined) {
      // 缺首段：只有“单个缺失段 + 单个工具”才能确定位置（工具之前）；多段/多工具一律降级。
      const boundaries = following.segment.ordinal;
      if (boundaries !== 1) return fallback("boundary-count-mismatch");
      const tools = toolIndicesIn(legacy, blockStart, following.segment.index - 1);
      if (tools.length !== 1) return fallback("boundary-count-mismatch");
      insertions.push({
        beforeIndex: tools[0]!,
        ordinal: 0,
        text: gapText,
        reference: following.segment,
      });
      continue;
    }

    // 缺中段：缺失正文属于“下一个已知段”的前缀（工具之后的续写），
    // 直接前缀合并即可，不能伪造一个同序号的新段（会与既有 #N 冲突）。
    const boundaries = following.segment.ordinal - preceding.segment.ordinal;
    if (boundaries > 1) return fallback("boundary-count-mismatch");
    if (boundaries === 1) {
      const tools = toolIndicesIn(legacy, preceding.segment.index + 1, following.segment.index - 1);
      if (tools.length !== 1) return fallback("boundary-count-mismatch");
    }
    edits.push({ segment: following.segment, side: "prefix", text: gapText });
  }

  return { mode: "inject", insertions, edits, reason: null };
}
