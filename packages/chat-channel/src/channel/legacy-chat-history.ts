// packages/chat-channel/src/channel/legacy-chat-history.ts
// 新同步协议的生产历史源：把旧 Chat Doc 的**已提交时间线**映射为 `importHistory` 的稳定记录。
//
// 为什么以旧 Chat Doc 为准：仓库内没有 Peri 持久化历史的读取契约（ACP `load_session` 只回放增量），
// 而旧 Chat Doc 是当前唯一可验证的稳定投影（内存或 Redis 快照）。这里只读取、不修改旧 Doc；
// 映射在 `sync/runtime` 之外完成，sync 层不依赖 `../state`。
//
// 映射规则：
// - 只取终态条目（completed / cancelled / error），pending / streaming 仍可能继续增长，不能封成历史；
// - 只取 `type: "text"` 的可见正文块，reasoning 与工具块不进入文本投影；
// - entryId 原样保留（`${turnId}:user` / `${turnId}:assistant`），新投影按同一身份与旧视图去重；
// - 长正文按代码单元切片，避免单条记录触碰入口原始帧上限；切片不拆代理对。
//
// 已知限制：导入发生在握手时，之后旧 Doc 新增的稳定条目不会自动追补（旧路径仍可见）；
// 条目级时间戳与非文本内容不在本次映射范围内。

import * as Y from "yjs";

import { getEntriesMap, getEntryOrder } from "../state/chat-writer";
import type { SyncHistoryRecord, SyncHistorySource } from "../sync/runtime/host-session";
import type { SnapshotHydration } from "../types";

/** 单条历史记录的文本上限（UTF-16 code units）：远低于入口原始帧上限，也避免长条目独占一次导入。 */
export const LEGACY_HISTORY_PART_CHARS = 64 * 1024;

/** 旧 Chat Doc 的最小读取面（DocManager 的形状子集，避免 channel 依赖具体实现）。 */
export interface LegacyChatDocumentSource {
  getChat(
    rcsSessionId: string,
  ): { readonly ydoc: Y.Doc; readonly hydration?: SnapshotHydration; readonly generation?: string } | undefined;
  openChat(rcsSessionId: string): Promise<{
    readonly ydoc: Y.Doc;
    readonly hydration?: SnapshotHydration;
    readonly generation?: string;
  }>;
}

/** 读取一个旧条目的可见正文；工具块和 reasoning 不计入。 */
function readVisibleText(entry: Y.Map<unknown>): string {
  const blocks = entry.get("blocks");
  const order = entry.get("blockOrder");
  if (!(blocks instanceof Y.Map) || !(order instanceof Y.Array)) return "";
  let text = "";
  for (const blockId of order.toArray()) {
    if (typeof blockId !== "string") continue;
    const block = blocks.get(blockId);
    if (!(block instanceof Y.Map) || block.get("type") !== "text") continue;
    const value = block.get("text");
    if (value instanceof Y.Text) text += value.toString();
  }
  return text;
}

/** 按 code units 切片，且不把代理对拆到两个记录（孤立代理项由保真序列化保留）。 */
function splitText(text: string, maxChars: number): string[] {
  const limit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : LEGACY_HISTORY_PART_CHARS;
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + limit, text.length);
    if (end < text.length && end > start + 1) {
      const code = text.charCodeAt(end - 1);
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    parts.push(text.slice(start, end));
    start = end;
  }
  return parts;
}

/**
 * 读取旧 Chat Doc 的已提交时间线；顺序严格按 `entryOrder`。
 *
 * 终态判定刻意保守：状态缺失的条目按稳定处理（旧数据可能没有该字段），而不确定性状态
 * （pending / streaming）一律跳过——把仍在增长的正文导入为历史会制造不可修正的截断。
 */
export function readLegacyCommittedHistory(ydoc: Y.Doc, maxPartChars = LEGACY_HISTORY_PART_CHARS): SyncHistoryRecord[] {
  const entries = getEntriesMap(ydoc);
  const records: SyncHistoryRecord[] = [];
  for (const entryId of getEntryOrder(ydoc).toArray()) {
    if (typeof entryId !== "string" || entryId.length === 0) continue;
    const entry = entries.get(entryId);
    if (!(entry instanceof Y.Map)) continue;
    const status = entry.get("status");
    if (status === "pending" || status === "streaming") continue;
    const role = entry.get("role");
    if (role !== "user" && role !== "assistant") continue;
    const text = readVisibleText(entry);
    if (text.length === 0) continue;
    for (const [partIndex, part] of splitText(text, maxPartChars).entries()) {
      records.push({
        value: part,
        meta: { kind: "text_part", entryId, contentSlot: 0, partIndex },
      });
    }
  }
  return records;
}

/** 组装生产历史源；`read` 时才打开旧 Doc，避免在连接建立前创建投影。 */
export function createLegacyChatHistorySource(input: {
  readonly docs: LegacyChatDocumentSource;
  readonly rcsSessionId: string;
  readonly acpSessionId: string | null;
  readonly maxPartChars?: number;
}): SyncHistorySource {
  return {
    acpSessionId: input.acpSessionId ?? "",
    async read(): Promise<readonly SyncHistoryRecord[]> {
      const existing = input.docs.getChat(input.rcsSessionId);
      const doc = existing ?? (await input.docs.openChat(input.rcsSessionId));
      // 生产 openChat 已等待快照水合；失败会抛错而不是给出空 Doc。这里仍显式拒绝
      // failed/stale 形状，防止其它 Doc 来源把“尚未水合”伪装成“确实无历史”。
      if (doc.hydration?.status === "failed" || doc.hydration?.status === "stale") {
        throw new Error(`旧 Chat Doc 快照未水合（${doc.hydration.status}），不能把空视图当作无历史`, {
          cause: doc.hydration.error,
        });
      }
      return readLegacyCommittedHistory(doc.ydoc, input.maxPartChars);
    },
  };
}
