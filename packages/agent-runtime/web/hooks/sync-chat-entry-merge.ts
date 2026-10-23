// packages/agent-runtime/web/hooks/sync-chat-entry-merge.ts
// 新旧双路助手正文的无损合并：旧投影分段提供工具位置，新投影整段提供正文完整性。
//
// 新投影把一条 entry 的全部文本压成一条消息、不携带工具位置（sync-doc-hub 跳过 tool_object），
// 因此合并必须同时满足：工具前的文本不被整段顶替；旧侧缺首段/中段/尾段、永久停滞或新侧已 final
// 时，新侧未被覆盖的正文仍要可见；缺口定位不得跨越工具边界盲目插入。
//
// 边界规则（content Doc 没有有序工具标记，只能从旧投影的分段序号推断）：
// - 分段 id 的 `#N` 是文本分段序号，`#0` 即入口 id；相邻已知段的序号差 = 其间文本分段边界数。
// - 只有「段间工具消息数 == 序号差」时边界才可判定：
//   缺首段 → 插在第一个工具之前；缺中段 → 插在第一个工具之后；缺尾段 → 插在末段后第一个工具之后。
// - 计数不一致 / 分段序号乱序 / 无工具却有边界 → 视为不可判定：整条 entry 退化为新投影单条消息，
//   保留工具与输入顺序，正文只出现一次。宁可整体退化，也不把缺口静默塞到未知工具的一侧。
// - 纯空白缺口不制造空消息，合并到相邻已知段；正文空白不丢失。
// - 合成段 id 必须在全部 legacy + sync 消息 id 中唯一；冲突时顺延序号。

import type { StructuredMessage } from "@fenix/chat-channel";

type AssistantMessage = Extract<StructuredMessage, { type: "assistant_message" }>;
type AssistantChunk = AssistantMessage["chunks"][number];

/** 助手正文（只取 message chunk，thought 不进入正文）。 */
export function assistantText(message: AssistantMessage): string {
  return message.chunks
    .filter((chunk) => chunk.type === "message")
    .map((chunk) => chunk.text)
    .join("");
}

interface EntrySegment {
  readonly message: AssistantMessage;
  readonly index: number;
  readonly text: string;
  readonly ordinal: number;
}

interface SegmentMatch {
  readonly segment: EntrySegment;
  readonly start: number;
  readonly end: number;
}

interface PlannedInsertion {
  readonly beforeIndex: number;
  readonly ordinal: number;
  readonly text: string;
  readonly reference: EntrySegment;
}

interface PlannedEdit {
  readonly segment: EntrySegment;
  readonly side: "prefix" | "suffix";
  readonly text: string;
}

interface GroupPlan {
  readonly mode: "skip" | "inject" | "fallback";
  readonly insertions: readonly PlannedInsertion[];
  readonly edits: readonly PlannedEdit[];
}

interface Insertion {
  readonly beforeIndex: number;
  readonly order: number;
  readonly message: AssistantMessage;
}

function prependSegmentText(message: AssistantMessage, text: string): AssistantMessage {
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

function appendSegmentText(message: AssistantMessage, text: string): AssistantMessage {
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

/** 把旧分段按出现顺序对齐到同步整段文本，返回已覆盖区间与未覆盖缺口。 */
function alignSegmentsToSyncText(
  syncText: string,
  segments: readonly EntrySegment[],
): { matches: SegmentMatch[]; gaps: Array<{ start: number; end: number }> } {
  const matches: SegmentMatch[] = [];
  let cursor = 0;
  for (const segment of segments) {
    if (segment.text.length === 0) continue;
    const position = syncText.indexOf(segment.text, cursor);
    if (position < 0) continue;
    matches.push({ segment, start: position, end: position + segment.text.length });
    cursor = position + segment.text.length;
  }
  const gaps: Array<{ start: number; end: number }> = [];
  let coveredUntil = 0;
  for (const match of matches) {
    if (match.start > coveredUntil) gaps.push({ start: coveredUntil, end: match.start });
    coveredUntil = match.end;
  }
  if (coveredUntil < syncText.length) gaps.push({ start: coveredUntil, end: syncText.length });
  return { matches, gaps };
}

/** 分段后缀序号：入口 id 为 0，`entryId#N` 为 N；其他形态返回 null（视为不可判定）。 */
function segmentOrdinal(id: string, base: string): number | null {
  if (id === base) return 0;
  if (!id.startsWith(`${base}#`)) return null;
  const suffix = id.slice(base.length + 1);
  return /^\d+$/.test(suffix) ? Number(suffix) : null;
}

/** 由序号生成入口/分段 id；0 复用入口 id，与 legacy 的 `entryId#N` 编号一致。 */
function idForOrdinal(base: string, ordinal: number): string {
  return ordinal === 0 ? base : `${base}#${ordinal}`;
}

/** 在全部既有 id 中取下一个空闲序号 id；冲突时顺延，绝不覆盖工具/计划/用户或其他 sync 消息。 */
function nextFreeEntryId(base: string, startOrdinal: number, reserved: Set<string>): string {
  let ordinal = Math.max(0, startOrdinal);
  let candidate = idForOrdinal(base, ordinal);
  while (reserved.has(candidate)) {
    ordinal += 1;
    candidate = idForOrdinal(base, ordinal);
  }
  reserved.add(candidate);
  return candidate;
}

/** 旧展示模型的分段后缀：`entryId#N`；entryId 自身可能已含 `#`。 */
function segmentParentId(id: string): string | null {
  const match = /#\d+$/.exec(id);
  return match === null ? null : id.slice(0, match.index);
}

/** 按「精确入口 id + 紧随其后的 `#N` 分段」索引旧助手消息，兼容 entryId 自身含 `#`。 */
function collectEntrySegments(legacy: readonly StructuredMessage[]): {
  exact: Map<string, AssistantMessage>;
  byParent: Map<string, AssistantMessage[]>;
} {
  const exact = new Map<string, AssistantMessage>();
  const byParent = new Map<string, AssistantMessage[]>();
  for (const message of legacy) {
    if (message.type !== "assistant_message") continue;
    exact.set(message.id, message);
    const parent = segmentParentId(message.id);
    if (parent === null) continue;
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(message);
    else byParent.set(parent, [message]);
  }
  return { exact, byParent };
}

/** 范围 [from, to] 内的工具消息下标；from > to 返回空。 */
function toolIndicesIn(legacy: readonly StructuredMessage[], from: number, to: number): number[] {
  const indices: number[] = [];
  for (let index = Math.max(0, from); index <= to && index < legacy.length; index += 1) {
    if (legacy[index]?.type === "tool_call") indices.push(index);
  }
  return indices;
}

/** 入口块边界：向前/向后吞掉紧邻的工具/计划消息，前缀/尾段缺口据此定位。 */
function blockBounds(
  legacy: readonly StructuredMessage[],
  firstIndex: number,
  lastIndex: number,
): { blockStart: number; blockEnd: number } {
  let blockStart = firstIndex;
  while (blockStart > 0) {
    const previous = legacy[blockStart - 1];
    if (previous?.type !== "tool_call" && previous?.type !== "plan") break;
    blockStart -= 1;
  }
  let blockEnd = lastIndex;
  while (blockEnd + 1 < legacy.length) {
    const next = legacy[blockEnd + 1];
    if (next?.type !== "tool_call" && next?.type !== "plan") break;
    blockEnd += 1;
  }
  return { blockStart, blockEnd };
}

/**
 * 判定一条 entry 的缺口如何落位。
 *
 * 只在「工具数 == 分段边界数」时给出精确位置；否则返回 fallback，由调用方整条退化为新投影单条消息。
 */
function planGroup(
  segments: readonly EntrySegment[],
  legacy: readonly StructuredMessage[],
  syncText: string,
  blockStart: number,
  blockEnd: number,
): GroupPlan {
  const { matches, gaps } = alignSegmentsToSyncText(syncText, segments);
  const insertions: PlannedInsertion[] = [];
  const edits: PlannedEdit[] = [];

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
      // 尾段：缺失正文从末段后第一个工具之后开始；没有工具则直接并入末段。
      const lastSegment = preceding?.segment ?? segments[segments.length - 1];
      if (lastSegment === undefined) return { mode: "fallback", insertions: [], edits: [] };
      const tools = toolIndicesIn(legacy, lastSegment.index + 1, blockEnd);
      if (tools.length === 0) {
        edits.push({ segment: lastSegment, side: "suffix", text: gapText });
      } else {
        insertions.push({
          beforeIndex: tools[0]! + 1,
          ordinal: lastSegment.ordinal + 1,
          text: gapText,
          reference: lastSegment,
        });
      }
      continue;
    }

    if (preceding === undefined) {
      // 缺首段：缺失正文在第一个分段边界之前，即第一个工具之前。
      const boundaries = following.segment.ordinal;
      if (boundaries <= 0) return { mode: "fallback", insertions: [], edits: [] };
      const tools = toolIndicesIn(legacy, blockStart, following.segment.index - 1);
      if (tools.length !== boundaries) return { mode: "fallback", insertions: [], edits: [] };
      insertions.push({
        beforeIndex: tools[0]!,
        ordinal: 0,
        text: gapText,
        reference: following.segment,
      });
      continue;
    }

    // 缺中段：缺失正文从上一个已知段后的第一个工具之后开始。
    const boundaries = following.segment.ordinal - preceding.segment.ordinal;
    if (boundaries <= 0) return { mode: "fallback", insertions: [], edits: [] };
    const tools = toolIndicesIn(legacy, preceding.segment.index + 1, following.segment.index - 1);
    if (tools.length !== boundaries) return { mode: "fallback", insertions: [], edits: [] };
    insertions.push({
      beforeIndex: tools[0]! + 1,
      ordinal: preceding.segment.ordinal + 1,
      text: gapText,
      reference: preceding.segment,
    });
  }

  return { mode: "inject", insertions, edits };
}

function makeInsertionMessage(
  base: string,
  ordinal: number,
  text: string,
  reference: EntrySegment,
  syncMessage: AssistantMessage,
  reserved: Set<string>,
): AssistantMessage {
  return {
    type: "assistant_message",
    id: nextFreeEntryId(base, ordinal, reserved),
    chunks: [{ type: "message", text }],
    seq: reference.message.seq,
    ts: syncMessage.ts > 0 ? syncMessage.ts : reference.message.ts,
  };
}

/**
 * 对「分段或工具邻接」的助手 entry 做无损合并。
 *
 * 返回的 `consumedSyncIds` 必须从后续配对/候选中剔除，否则整段新正文会顶掉工具前的段。
 */
export function applyLosslessEntryMerge(
  legacy: readonly StructuredMessage[],
  sync: readonly StructuredMessage[],
): { legacy: StructuredMessage[]; consumedSyncIds: Set<string> } {
  const { exact, byParent } = collectEntrySegments(legacy);
  const indexById = new Map<string, number>();
  for (let index = 0; index < legacy.length; index += 1) {
    const message = legacy[index];
    if (message !== undefined) indexById.set(message.id, index);
  }

  const syncById = new Map<string, AssistantMessage>();
  for (const message of sync) {
    if (message.type !== "assistant_message") continue;
    const existing = syncById.get(message.id);
    if (existing === undefined || assistantText(message).length > assistantText(existing).length) {
      syncById.set(message.id, message);
    }
  }

  const reserved = new Set<string>();
  for (const message of legacy) reserved.add(message.id);
  for (const message of sync) reserved.add(message.id);

  interface Analysis {
    readonly base: string;
    readonly syncMessage: AssistantMessage;
    readonly segments: EntrySegment[];
    readonly blockStart: number;
    readonly blockEnd: number;
    readonly mode: "skip" | "inject" | "fallback";
    readonly plan: GroupPlan | null;
  }

  const analyses: Analysis[] = [];
  for (const [base, syncMessage] of syncById) {
    const group: AssistantMessage[] = [];
    const seen = new Set<string>();
    const baseSegment = exact.get(base);
    if (baseSegment !== undefined) {
      group.push(baseSegment);
      seen.add(baseSegment.id);
    }
    for (const segment of byParent.get(base) ?? []) {
      if (seen.has(segment.id)) continue;
      group.push(segment);
      seen.add(segment.id);
    }
    if (group.length === 0) continue;

    const segments: EntrySegment[] = [];
    for (const message of group) {
      const ordinal = segmentOrdinal(message.id, base);
      if (ordinal === null) {
        segments.length = 0;
        break;
      }
      const index = indexById.get(message.id);
      if (index === undefined) {
        segments.length = 0;
        break;
      }
      segments.push({ message, index, text: assistantText(message), ordinal });
    }
    if (segments.length === 0) continue;
    segments.sort((left, right) => left.index - right.index);

    // 乱序 legacy 不能拿来推断工具边界：整条退化为新投影单条消息（安全降级）。
    let ordered = true;
    for (let index = 1; index < segments.length; index += 1) {
      if (segments[index]!.ordinal <= segments[index - 1]!.ordinal) ordered = false;
    }

    const firstSegment = segments[0];
    const lastSegment = segments[segments.length - 1];
    if (firstSegment === undefined || lastSegment === undefined) continue;
    const { blockStart, blockEnd } = blockBounds(legacy, firstSegment.index, lastSegment.index);

    let toolAdjacent = false;
    for (let index = blockStart; index <= blockEnd; index += 1) {
      if (legacy[index]?.type === "tool_call") {
        toolAdjacent = true;
        break;
      }
    }
    const segmented = segments.length > 1 || firstSegment.ordinal > 0;
    const syncText = assistantText(syncMessage);
    if (syncText.length === 0) continue;
    if (!ordered) {
      analyses.push({ base, syncMessage, segments, blockStart, blockEnd, mode: "fallback", plan: null });
      continue;
    }
    if (!toolAdjacent && !segmented) continue;
    const plan = planGroup(segments, legacy, syncText, blockStart, blockEnd);
    analyses.push({ base, syncMessage, segments, blockStart, blockEnd, mode: plan.mode, plan });
  }

  const consumedSyncIds = new Set<string>();
  const removedIds = new Set<string>();
  for (const analysis of analyses) {
    if (analysis.mode === "skip") continue;
    consumedSyncIds.add(analysis.base);
    if (analysis.mode === "fallback") {
      for (const segment of analysis.segments) removedIds.add(segment.message.id);
    }
  }
  // 被移除/被消费的消息 id 让位给合成段；其余 sync/legacy/tool id 全部保留，保证全局唯一。
  for (const id of removedIds) reserved.delete(id);
  for (const id of consumedSyncIds) reserved.delete(id);

  const replacements = new Map<string, AssistantMessage>();
  const insertions: Insertion[] = [];
  let order = 0;

  for (const analysis of analyses) {
    if (analysis.mode === "skip") continue;
    const firstSegment = analysis.segments[0];
    if (firstSegment === undefined) continue;

    if (analysis.mode === "fallback") {
      const desired = analysis.syncMessage.id;
      let id = desired;
      if (reserved.has(desired)) id = nextFreeEntryId(analysis.base, 0, reserved);
      else reserved.add(desired);
      insertions.push({
        beforeIndex: firstSegment.index,
        order: order++,
        message: { ...analysis.syncMessage, id },
      });
      continue;
    }

    const plan = analysis.plan;
    if (plan === null) continue;
    for (const edit of plan.edits) {
      const current = replacements.get(edit.segment.message.id) ?? edit.segment.message;
      const next =
        edit.side === "prefix" ? prependSegmentText(current, edit.text) : appendSegmentText(current, edit.text);
      replacements.set(edit.segment.message.id, next);
    }
    for (const planned of plan.insertions) {
      insertions.push({
        beforeIndex: planned.beforeIndex,
        order: order++,
        message: makeInsertionMessage(
          analysis.base,
          planned.ordinal,
          planned.text,
          planned.reference,
          analysis.syncMessage,
          reserved,
        ),
      });
    }
  }

  if (replacements.size === 0 && insertions.length === 0 && consumedSyncIds.size === 0) {
    return { legacy: [...legacy], consumedSyncIds };
  }

  insertions.sort((left, right) => left.beforeIndex - right.beforeIndex || left.order - right.order);
  const insertionsByIndex = new Map<number, Insertion[]>();
  for (const insertion of insertions) {
    const bucket = insertionsByIndex.get(insertion.beforeIndex);
    if (bucket) bucket.push(insertion);
    else insertionsByIndex.set(insertion.beforeIndex, [insertion]);
  }

  const merged: StructuredMessage[] = [];
  for (let index = 0; index <= legacy.length; index += 1) {
    for (const insertion of insertionsByIndex.get(index) ?? []) merged.push(insertion.message);
    if (index === legacy.length) break;
    const message = legacy[index];
    if (message === undefined) continue;
    if (removedIds.has(message.id)) continue;
    merged.push(replacements.get(message.id) ?? message);
  }
  return { legacy: merged, consumedSyncIds };
}
