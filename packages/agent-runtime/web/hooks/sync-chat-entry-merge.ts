// packages/agent-runtime/web/hooks/sync-chat-entry-merge.ts
// 新旧双路助手正文的无损合并：旧投影分段提供工具位置，新投影整段提供正文完整性。
//
// 新投影把一条 entry 的全部文本压成一条消息、不携带工具位置（sync-doc-hub 跳过 tool_object），
// 因此合并必须同时满足：工具前的文本不被整段顶替；旧侧缺首段/中段/尾段、永久停滞或新侧已 final
// 时，新侧未被覆盖的正文仍要可见。这里只处理「分段或工具邻接」的 entry，纯文本 entry 交给
// sync-chat-messages 的 preferredMessage。

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
}

interface SegmentMatch {
  readonly segment: EntrySegment;
  readonly start: number;
  readonly end: number;
}

interface EntryInjectionPlan {
  readonly replacements: Map<string, AssistantMessage>;
  readonly tail: { readonly afterIndex: number; readonly message: AssistantMessage } | null;
}

/** 在段首合并正文：保留 thought 块位置，只改第一条 message chunk。 */
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

/** 在段尾合并正文：与同步投影的拼接顺序一致，保留其后可能存在的 thought 块。 */
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

/**
 * 把旧分段按出现顺序对齐到同步整段文本。
 *
 * 两路正文来自同一 ACP 增量流：旧侧是「工具切段后的前缀/子集」，新侧是完整拼接。能对齐的段给出
 * 覆盖区间，剩余区间就是新侧比旧侧多出的正文；对齐失败的段不参与计算，但其旧文本仍保留。
 */
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

/** 未被旧侧占用的下一个顺序段 id（与 legacy 的 `entryId#N` 编号兼容，追平后 id 稳定）。 */
function nextFreeSegmentId(base: string, segments: readonly EntrySegment[]): string {
  const used = new Set(segments.map((segment) => segment.message.id));
  let index = 1;
  while (used.has(`${base}#${index}`)) index += 1;
  return `${base}#${index}`;
}

/**
 * 旧侧分段为骨架、新侧整段为正文来源的无损合并计划。
 *
 * 新投影不携带工具位置，因此：
 * - 旧侧已覆盖的正文原样保留在工具两侧；
 * - 新侧多出的正文按同步顺序补到「紧随其后的已知段」之前；没有后续已知段时补到条目末尾
 *   （若末尾是工具则排在工具之后）；
 * - 两路无法对齐时把整段新正文作为条目尾段兜底，宁可重复也不能永久隐藏正文。
 */
function planEntryInjection(
  base: string,
  segments: readonly EntrySegment[],
  blockLastIndex: number,
  syncMessage: AssistantMessage,
): EntryInjectionPlan {
  const syncText = assistantText(syncMessage);
  const replacements = new Map<string, AssistantMessage>();
  const { matches, gaps } = alignSegmentsToSyncText(syncText, segments);
  let tailText = "";

  const assignTrailing = (text: string): void => {
    if (text.length === 0) return;
    const lastMatch = matches.length > 0 ? matches[matches.length - 1] : undefined;
    if (lastMatch !== undefined && lastMatch.segment.index === blockLastIndex) {
      const current = replacements.get(lastMatch.segment.message.id) ?? lastMatch.segment.message;
      replacements.set(lastMatch.segment.message.id, appendSegmentText(current, text));
      return;
    }
    // 尾文必须排在工具之后；纯空白不制造空消息。
    if (text.trim().length > 0) tailText += text;
  };

  if (matches.length === 0) {
    const legacyText = segments.map((segment) => segment.text).join("");
    if (!legacyText.startsWith(syncText)) {
      if (syncText.startsWith(legacyText)) {
        assignTrailing(syncText.slice(legacyText.length));
      } else if (syncText.trim().length > 0) {
        tailText += syncText;
      }
    }
  } else {
    for (const gap of gaps) {
      const gapText = syncText.slice(gap.start, gap.end);
      if (gapText.length === 0) continue;
      const next = matches.find((match) => match.start >= gap.end);
      if (next !== undefined) {
        const current = replacements.get(next.segment.message.id) ?? next.segment.message;
        replacements.set(next.segment.message.id, prependSegmentText(current, gapText));
      } else {
        assignTrailing(gapText);
      }
    }
  }

  if (tailText.length === 0) return { replacements, tail: null };
  const lastSegment = segments[segments.length - 1];
  const tail: AssistantMessage = {
    type: "assistant_message",
    id: nextFreeSegmentId(base, segments),
    chunks: [{ type: "message", text: tailText }],
    seq: lastSegment?.message.seq ?? syncMessage.seq,
    ts: syncMessage.ts > 0 ? syncMessage.ts : (lastSegment?.message.ts ?? 0),
  };
  return { replacements, tail: { afterIndex: blockLastIndex, message: tail } };
}

/** 旧展示模型的分段后缀：`entryId#N`（N 为十进制序号）；entryId 自身可能已含 `#`。 */
function segmentParentId(id: string): string | null {
  const match = /#\d+$/.exec(id);
  return match === null ? null : id.slice(0, match.index);
}

/** 按「精确入口 id + 紧随其后的 `#N` 分段」索引旧助手消息，兼容 entryId 自身含 `#`。 */
function collectEntrySegments(legacy: readonly StructuredMessage[]): {
  exact: Map<string, EntrySegment>;
  byParent: Map<string, EntrySegment[]>;
} {
  const exact = new Map<string, EntrySegment>();
  const byParent = new Map<string, EntrySegment[]>();
  for (let index = 0; index < legacy.length; index += 1) {
    const message = legacy[index];
    if (message?.type !== "assistant_message") continue;
    const segment: EntrySegment = { message, index, text: assistantText(message) };
    exact.set(message.id, segment);
    const parent = segmentParentId(message.id);
    if (parent === null) continue;
    const bucket = byParent.get(parent);
    if (bucket) bucket.push(segment);
    else byParent.set(parent, [segment]);
  }
  return { exact, byParent };
}

/**
 * 对「分段或工具邻接」的助手 entry 做无损合并：旧侧分段作为结构骨架，新侧整段补齐旧侧缺失的正文。
 *
 * 只有这类 entry 需要该处理：无工具的单段 entry 由 `preferredMessage` 选更长一侧即可，顺序不受影响。
 * 返回的 `consumedSyncIds` 必须从后续配对/候选中剔除，否则整段新正文会顶掉工具前的段。
 */
export function applyLosslessEntryMerge(
  legacy: readonly StructuredMessage[],
  sync: readonly StructuredMessage[],
): { legacy: StructuredMessage[]; consumedSyncIds: Set<string> } {
  const { exact, byParent } = collectEntrySegments(legacy);

  const syncById = new Map<string, AssistantMessage>();
  for (const message of sync) {
    if (message.type !== "assistant_message") continue;
    const existing = syncById.get(message.id);
    if (existing === undefined || assistantText(message).length > assistantText(existing).length) {
      syncById.set(message.id, message);
    }
  }

  const replacements = new Map<string, AssistantMessage>();
  const tails = new Map<number, AssistantMessage[]>();
  const consumedSyncIds = new Set<string>();

  for (const [base, syncMessage] of syncById) {
    const group: EntrySegment[] = [];
    const seen = new Set<string>();
    const baseSegment = exact.get(base);
    if (baseSegment !== undefined) {
      group.push(baseSegment);
      seen.add(baseSegment.message.id);
    }
    for (const segment of byParent.get(base) ?? []) {
      if (seen.has(segment.message.id)) continue;
      group.push(segment);
      seen.add(segment.message.id);
    }
    if (group.length === 0) continue;
    group.sort((left, right) => left.index - right.index);

    const firstSegment = group[0];
    const lastSegment = group[group.length - 1];
    if (firstSegment === undefined || lastSegment === undefined) continue;

    let blockLastIndex = lastSegment.index;
    while (blockLastIndex + 1 < legacy.length) {
      const next = legacy[blockLastIndex + 1];
      if (next?.type !== "tool_call" && next?.type !== "plan") break;
      blockLastIndex += 1;
    }
    let toolAdjacent = false;
    for (let index = firstSegment.index; index <= blockLastIndex; index += 1) {
      if (legacy[index]?.type === "tool_call") {
        toolAdjacent = true;
        break;
      }
    }
    const segmented = group.length > 1 || group.some((segment) => segment.message.id !== base);
    if (!toolAdjacent && !segmented) continue;

    const plan = planEntryInjection(base, group, blockLastIndex, syncMessage);
    for (const [id, message] of plan.replacements) replacements.set(id, message);
    if (plan.tail !== null) {
      const bucket = tails.get(plan.tail.afterIndex);
      if (bucket) bucket.push(plan.tail.message);
      else tails.set(plan.tail.afterIndex, [plan.tail.message]);
    }
    consumedSyncIds.add(base);
  }

  if (replacements.size === 0 && tails.size === 0 && consumedSyncIds.size === 0) {
    return { legacy: [...legacy], consumedSyncIds };
  }
  const merged: StructuredMessage[] = [];
  for (let index = 0; index < legacy.length; index += 1) {
    const message = legacy[index];
    if (message === undefined) continue;
    merged.push(replacements.get(message.id) ?? message);
    const tail = tails.get(index);
    if (tail !== undefined) merged.push(...tail);
  }
  return { legacy: merged, consumedSyncIds };
}
