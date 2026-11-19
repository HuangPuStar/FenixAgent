import { SyncProtocolError } from "../protocol/errors";
import { readTextClaimDoc } from "./text-claim-read";
import type { TextClaimStore } from "./text-claim-store";
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
  readonly store: TextClaimStore;
  readonly admission: AdmissionBudget;
  readonly scopeKey: string;
  readonly generation: string;
  readonly activeDocId: string;
  readonly docIds: ReadonlySet<string>;
  readonly assertCurrent: () => void;
  readonly accept: (key: string) => void;
}): Promise<void> {
  let temporaryBytes = 256;
  for (const id of input.docIds) temporaryBytes += 256 + id.length * 4;
  const hold = input.admission.reserve("controlIndex", temporaryBytes);
  try {
    const candidates = [...input.docIds].filter((docId) => docId !== input.activeDocId);
    if (candidates.length === 0) return;
    const covered = await input.store.readLiveTextCoverage({
      scopeKey: input.scopeKey,
      generation: input.generation,
      docIds: candidates,
    });
    for (const docId of candidates) {
      if (covered.has(docId)) continue;
      const loaded = await readTextClaimDoc({
        store: input.store,
        admission: input.admission,
        scopeKey: input.scopeKey,
        docId,
        assertCurrent: input.assertCurrent,
        consume(doc) {
          for (const record of records<StoredTextRecord>(doc)?.toArray() ?? []) {
            if (record.kind === "text" && typeof record.entryId === "string" && typeof record.contentSlot === "string")
              input.accept(textClaimKey(record.entryId, record.contentSlot));
          }
          return true;
        },
      });
      if (loaded === null)
        throw new SyncProtocolError("DOC_NOT_FOUND", { message: "text claim predecessor has no committed state" });
    }
  } finally {
    hold.release();
  }
}

import type { AdmissionBudget } from "../capacity/admission";
