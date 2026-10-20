// packages/chat-channel/src/sync/live/text-claim.ts
// 用户消息幂等的已提交判据：当前活跃内容块 + 当前代次的历史导入块。
//
// 为什么不能只看活跃块：历史导入的文本记录在已封口块里，且旧协议用数字槽位 0，而实时用户消息用
// "text" 槽位。两者等价性只能由 entryId 表达（entryId 已含 turnId），按 entryId（而不是正文）判重，
// 既不会漏掉历史消息，也不会把不同轮次的相同文本误判成重复。

import * as Y from "yjs";

import type { ProjectionStore } from "../store/types";
import { records } from "./writer-support";

/** 记录数组里的最小读取面：历史记录是 `text_part` + 数字槽位，实时记录是 `text` + 字符串槽位。 */
interface StoredTextRecord {
  readonly entryId?: unknown;
  readonly contentSlot?: unknown;
  readonly kind?: unknown;
}

export interface TextClaim {
  /**
   * 返回 true 表示本次输入尚未提交；false 表示同一 entryId + 槽位已存在，或本写者已接收过。
   *
   * `historyDocIds` 必须来自当前代次的入口闭包；`readDocStateAt` 对退役块返回 `null`，
   * 因此不可达块不会把新消息误判成“已存在”。
   */
  claim(input: {
    readonly entryId: string;
    readonly contentSlot: string;
    readonly activeDoc: Y.Doc;
    readonly historyDocIds: readonly string[];
  }): Promise<boolean>;
  /** 重建后丢弃本机未落地的声明与历史缓存：已提交事实必须重新读取。 */
  reset(): void;
}

export function createTextClaim(store: ProjectionStore): TextClaim {
  const claimed = new Set<string>();
  let historicalEntries: ReadonlySet<string> | null = null;
  let historyLoad: Promise<ReadonlySet<string>> | null = null;

  function keyOf(entryId: string, contentSlot: string): string {
    return `${entryId}\u0000${contentSlot}`;
  }

  async function loadHistoricalEntries(docIds: readonly string[], activeDocId: string): Promise<ReadonlySet<string>> {
    const entries = new Set<string>();
    for (const docId of docIds) {
      // 活跃块由实时记录判重；这里只补它看不到的已封口块，同一份记录不读两次。
      if (docId === activeDocId) continue;
      const state = await store.readDocStateAt(docId, 0);
      if (state === null) continue;
      const doc = new Y.Doc({ guid: docId });
      try {
        Y.applyUpdate(doc, state.snapshot);
        for (const record of records<StoredTextRecord>(doc)?.toArray() ?? []) {
          if (record.kind === "text_part" && typeof record.entryId === "string") entries.add(record.entryId);
        }
      } finally {
        doc.destroy();
      }
    }
    return entries;
  }

  /** 历史块只扫描一次；失败不缓存，下一次 claim 重新读取。 */
  async function historicalEntriesFor(docIds: readonly string[], activeDocId: string): Promise<ReadonlySet<string>> {
    if (historicalEntries !== null) return historicalEntries;
    if (historyLoad === null) {
      historyLoad = loadHistoricalEntries(docIds, activeDocId).catch((error: unknown) => {
        historyLoad = null;
        throw error;
      });
    }
    historicalEntries = await historyLoad;
    return historicalEntries;
  }

  return {
    async claim(input) {
      const key = keyOf(input.entryId, input.contentSlot);
      if (claimed.has(key)) return false;
      // 先占位再读历史：两个并发的同键输入不能在异步窗口内都通过检查。
      claimed.add(key);
      try {
        const active = records<StoredTextRecord>(input.activeDoc)?.toArray() ?? [];
        if (active.some((record) => record.entryId === input.entryId && record.contentSlot === input.contentSlot)) {
          return false;
        }
        if (input.historyDocIds.length === 0) return true;
        const entries = await historicalEntriesFor(input.historyDocIds, input.activeDoc.guid);
        return !entries.has(input.entryId);
      } catch (error) {
        // 读取失败不能把消息永久判成已写：释放占位，调用方重试时重新判定。
        claimed.delete(key);
        throw error;
      }
    },
    reset() {
      claimed.clear();
      historicalEntries = null;
      historyLoad = null;
    },
  };
}
