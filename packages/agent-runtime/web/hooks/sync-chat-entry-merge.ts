// packages/agent-runtime/web/hooks/sync-chat-entry-merge.ts
// 新旧双路正文合并：完整 marker 按工具 occurrence 定位，旧数据沿用启发式并显式降级。
// fallback 保留 thought/error 的原始 chunk 位置；两路进度不一致不能隐藏已可见正文。

import type { StructuredMessage } from "@fenix/chat-channel";
import { fallbackSegments, fallbackText } from "./sync-chat-fallback";
import { type GroupPlan, planGroup } from "./sync-chat-heuristic-merge";
import {
  type AssistantMessage,
  appendSegmentText,
  assistantText,
  type EntrySegment,
  type MergeDegradation,
  type MergeDegradeReason,
  type PlannedEdit,
  type PlannedInsertion,
  prependSegmentText,
} from "./sync-chat-merge-types";
import { planStructuralGroup, type StructuralPlan } from "./sync-chat-structural-merge";

interface Insertion {
  readonly beforeIndex: number;
  readonly order: number;
  readonly message: AssistantMessage;
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
): { legacy: StructuredMessage[]; consumedSyncIds: Set<string>; degraded: MergeDegradation[] } {
  const { exact, byParent } = collectEntrySegments(legacy);
  const indexById = new Map<string, number>();
  for (let index = 0; index < legacy.length; index += 1) {
    const message = legacy[index];
    if (message !== undefined) indexById.set(message.id, index);
  }

  // 同步投影按入口 id 分组：标记存在时同一 entry 会有 base / base#1 / … 多条消息。
  // `entryBaseId` 由镜像层显式提供；手工/旧消息退回“去掉末尾 #N”的解析。
  const syncGroups = new Map<string, AssistantMessage[]>();
  for (const message of sync) {
    if (message.type !== "assistant_message") continue;
    const base = message.entryBaseId ?? segmentParentId(message.id) ?? message.id;
    const bucket = syncGroups.get(base);
    if (bucket) bucket.push(message);
    else syncGroups.set(base, [message]);
  }
  for (const [base, messages] of syncGroups) {
    const unique = new Map<string, AssistantMessage>();
    for (const message of messages) unique.set(message.id, message);
    syncGroups.set(
      base,
      [...unique.values()].sort(
        (left, right) => (segmentOrdinal(left.id, base) ?? 0) - (segmentOrdinal(right.id, base) ?? 0),
      ),
    );
  }

  const reserved = new Set<string>();
  for (const message of legacy) reserved.add(message.id);
  for (const message of sync) reserved.add(message.id);

  interface Analysis {
    readonly base: string;
    readonly syncMessages: AssistantMessage[];
    readonly syncMessage: AssistantMessage;
    readonly segments: EntrySegment[];
    readonly blockStart: number;
    readonly blockEnd: number;
    readonly mode: "skip" | "inject" | "fallback";
    readonly plan: GroupPlan | null;
    readonly structural: StructuralPlan | null;
    readonly degradeReason: MergeDegradeReason | null;
  }

  const analyses: Analysis[] = [];
  const degraded: MergeDegradation[] = [];

  for (const [base, syncMessages] of syncGroups) {
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
    if (group.length === 0) {
      // 新投影有分段但旧侧完全没有文本锚点：不消费，交给通用合并器按序追加；显式降级。
      const structural =
        syncMessages.length > 1 || syncMessages.some((message) => (segmentOrdinal(message.id, base) ?? 0) > 0);
      if (structural) degraded.push({ entryId: base, reason: "missing-text-anchor" });
      continue;
    }

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
    const primary = syncMessages.find((message) => (segmentOrdinal(message.id, base) ?? -1) === 0) ?? syncMessages[0]!;
    const structuralGroup =
      syncMessages.length > 1 ||
      syncMessages.some(
        (message) =>
          (message.entryBoundaryCount ?? 0) > 0 ||
          message.entryBoundaryIssue === true ||
          (segmentOrdinal(message.id, base) ?? 0) > 0,
      );

    if (!ordered) {
      analyses.push({
        base,
        syncMessages,
        syncMessage: primary,
        segments,
        blockStart,
        blockEnd,
        mode: "fallback",
        plan: null,
        structural: null,
        degradeReason: "unordered-legacy",
      });
      continue;
    }
    if (!toolAdjacent && !segmented) continue;

    if (structuralGroup) {
      // 标记存在：按段序号与工具 run 精确落位，不再使用字符串启发式。
      const plan = planStructuralGroup({
        legacy,
        base,
        legacySegments: segments,
        syncMessages,
        blockStart,
        blockEnd,
      });
      analyses.push({
        base,
        syncMessages,
        syncMessage: primary,
        segments,
        blockStart,
        blockEnd,
        mode: plan.mode,
        plan: null,
        structural: plan,
        degradeReason: plan.mode === "fallback" ? (plan.reason ?? "boundary-count-mismatch") : null,
      });
      continue;
    }

    // 标记缺失（旧数据/旧协议）：保留原有启发式，并显式上报降级。
    const syncText = assistantText(primary);
    if (syncText.length === 0) continue;
    const plan = planGroup(segments, legacy, syncText, blockStart, blockEnd);
    const degradeReason =
      plan.mode === "fallback"
        ? (plan.reason ?? "boundary-count-mismatch")
        : plan.insertions.length > 0 || plan.edits.length > 0
          ? "markers-missing"
          : null;
    analyses.push({
      base,
      syncMessages,
      syncMessage: primary,
      segments,
      blockStart,
      blockEnd,
      mode: plan.mode,
      plan,
      structural: null,
      degradeReason,
    });
  }

  const consumedSyncIds = new Set<string>();
  const removedIds = new Set<string>();
  for (const analysis of analyses) {
    if (analysis.mode === "skip") continue;
    for (const message of analysis.syncMessages) consumedSyncIds.add(message.id);
    if (analysis.mode === "fallback") {
      for (const segment of analysis.segments) removedIds.add(segment.message.id);
    }
  }
  // 只有被移除的旧段和被消费且不再被任何保留消息占用的 sync id 才让位给合成段；
  // 同 id 的用户/工具/计划仍在保留集中，合成段必须另选空闲 id，绝不能覆盖它们。
  const retainedLegacyIds = new Set(legacy.map((message) => message.id));
  for (const id of removedIds) retainedLegacyIds.delete(id);
  for (const id of removedIds) reserved.delete(id);
  for (const id of consumedSyncIds) {
    if (!retainedLegacyIds.has(id)) reserved.delete(id);
  }
  for (const analysis of analyses) {
    if (analysis.degradeReason !== null) {
      degraded.push({ entryId: analysis.base, reason: analysis.degradeReason });
    }
  }

  const replacements = new Map<string, AssistantMessage>();
  const insertions: Insertion[] = [];
  let order = 0;

  const applyEdit = (edit: PlannedEdit): void => {
    const current = replacements.get(edit.segment.message.id) ?? edit.segment.message;
    const next =
      edit.side === "prefix" ? prependSegmentText(current, edit.text) : appendSegmentText(current, edit.text);
    replacements.set(edit.segment.message.id, next);
  };
  const pushInsertion = (analysis: Analysis, planned: PlannedInsertion): void => {
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
  };

  for (const analysis of analyses) {
    if (analysis.mode === "skip") continue;
    const firstSegment = analysis.segments[0];
    if (firstSegment === undefined) continue;

    if (analysis.mode === "fallback") {
      // 降级消息使用整条 entry 的合并正文（标记存在时可能有多段），id 必须全局唯一。
      const combinedText = fallbackText(
        analysis.segments,
        analysis.syncMessages
          .slice()
          .sort(
            (left, right) =>
              (segmentOrdinal(left.id, analysis.base) ?? 0) - (segmentOrdinal(right.id, analysis.base) ?? 0),
          )
          .map(assistantText)
          .join(""),
      );
      const preserved = fallbackSegments(analysis.segments, combinedText);
      if (preserved !== null) {
        for (const [index, segment] of analysis.segments.entries()) {
          removedIds.delete(segment.message.id);
          replacements.set(segment.message.id, preserved[index]!);
        }
        continue;
      }
      if (combinedText.length === 0) continue;
      const desired = analysis.base;
      let id = desired;
      if (reserved.has(desired)) id = nextFreeEntryId(analysis.base, 0, reserved);
      else reserved.add(desired);
      insertions.push({
        beforeIndex: firstSegment.index,
        order: order++,
        message: {
          ...analysis.syncMessage,
          id,
          chunks: [{ type: "message", text: combinedText }],
        },
      });
      continue;
    }

    if (analysis.structural !== null) {
      for (const edit of analysis.structural.edits) applyEdit(edit);
      for (const planned of analysis.structural.insertions) pushInsertion(analysis, planned);
      continue;
    }

    const plan = analysis.plan;
    if (plan === null) continue;
    for (const edit of plan.edits) applyEdit(edit);
    for (const planned of plan.insertions) pushInsertion(analysis, planned);
  }

  if (replacements.size === 0 && insertions.length === 0 && consumedSyncIds.size === 0) {
    return { legacy: [...legacy], consumedSyncIds, degraded };
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
  return { legacy: merged, consumedSyncIds, degraded };
}
