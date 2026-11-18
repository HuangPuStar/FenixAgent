import { SyncProtocolError } from "../protocol/errors";
import type { ProjectionStore } from "../store/types";
import { loadCommittedDoc } from "./committed-doc";
import { records } from "./writer-support";

/** 历史导入与 live 记录保留各自槽位语义，只共享最小的只读解析面。 */
export interface StoredTextRecord {
  readonly entryId?: unknown;
  readonly contentSlot?: unknown;
  readonly kind?: unknown;
}

/** 字符串元组避免自由字符串分隔符与 entryId、slot 相互混淆。 */
export function textClaimKey(entryId: string, contentSlot: string): string {
  return JSON.stringify([entryId, contentSlot]);
}

/** 旧块逐 Doc 加载 canonical 与连续 tail；调用方只缓存身份，不保留正文或 Y.Doc。 */
export async function legacyLiveTextClaims(input: {
  readonly store: ProjectionStore;
  readonly activeDocId: string;
  readonly docIds: ReadonlySet<string>;
}): Promise<ReadonlySet<string>> {
  const entries = new Set<string>();
  for (const docId of input.docIds) {
    if (docId === input.activeDocId) continue;
    const loaded = await loadCommittedDoc(input.store, docId);
    if (!loaded)
      throw new SyncProtocolError("DOC_NOT_FOUND", { message: "text claim predecessor has no committed state" });
    try {
      for (const record of records<StoredTextRecord>(loaded.doc)?.toArray() ?? []) {
        if (record.kind === "text" && typeof record.entryId === "string" && typeof record.contentSlot === "string")
          entries.add(textClaimKey(record.entryId, record.contentSlot));
      }
    } finally {
      loaded.doc.destroy();
    }
  }
  return entries;
}
