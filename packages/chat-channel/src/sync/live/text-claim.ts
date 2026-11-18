import * as Y from "yjs";
import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import { parseDocId } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";
import { loadCommittedDoc } from "./committed-doc";
import type { LiveRecordValue } from "./live-writer-types";
import { legacyLiveTextClaims, type StoredTextRecord, textClaimKey } from "./text-claim-history";
import { type TextClaimIdentity, textClaimLookupId } from "./text-claim-identity";
import { createTextClaimLineage, type TextClaimLineage } from "./text-claim-lineage";
import { records } from "./writer-support";

/** 仅本声明生命周期的失效可重新判定，其他同码错误不提供安全重试证据。 */
class TextClaimInvalidatedError extends SyncProtocolError {
  constructor(activeDocId: string, cause?: unknown) {
    super("GENERATION_MISMATCH", {
      retryable: true,
      safeContext: { docId: activeDocId },
      message: "text claim invalidated by writer state rebuild",
      ...(cause === undefined ? {} : { cause }),
    });
  }
}

/** 识别由本地重建直接证明的旧声明失效，供写者限定同代次重新判定。 */
export function isTextClaimInvalidated(error: unknown): error is SyncProtocolError {
  return error instanceof TextClaimInvalidatedError;
}

/** 单写者的暂存声明与当前代次的已提交文本判重入口。 */
export interface TextClaim {
  /** false 表示同 entryId + 槽位已提交或本写者已接收；失败不会留下新占位。 */
  claim(input: {
    readonly generation: string;
    readonly entryId: string;
    readonly contentSlot: string;
    readonly activeDoc: Y.Doc;
    readonly historyDocIds: readonly string[];
  }): Promise<boolean>;
  /** 只有已证明未进入存储的冲刷才能释放对应占位。 */
  release(entryId: string, contentSlot: string): void;
  /** 重建后丢弃声明与旧数据缓存，使在途旧声明失效。 */
  reset(): void;
}

/** 索引命中仍核对 canonical + 连续 tail；损坏引用不能冒充已提交事实。 */
async function indexedTextExists(
  store: ProjectionStore,
  digest: DigestFn,
  identity: TextClaimIdentity,
  lineage: TextClaimLineage,
  activeDocId: string,
): Promise<boolean> {
  const lookupId = textClaimLookupId(digest, identity);
  const [ref] = await store.locateRefs({
    generation: identity.generation,
    lookupKind: "live-text",
    lookupId,
    contentSlot: 0,
    partIndex: 0,
    limit: 1,
  });
  if (!ref) return false;
  if (
    ref.scopeKey !== identity.scopeKey ||
    ref.generation !== identity.generation ||
    ref.lookupKind !== "live-text" ||
    ref.lookupId !== lookupId ||
    ref.contentSlot !== 0 ||
    ref.partIndex !== 0
  )
    throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim reference crosses its identity" });
  const reachable = await lineage.read(identity.generation, activeDocId);
  if (!reachable.has(ref.docId))
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "text claim reference is outside its live lineage" });
  const loaded = await loadCommittedDoc(store, ref.docId);
  if (!loaded) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "text claim reference has no committed state" });
  try {
    const record = records<LiveRecordValue>(loaded.doc)
      ?.toArray()
      .find((item) => item.recordId === ref.recordId);
    if (
      record?.kind !== "text" ||
      record.entryId !== identity.entryId ||
      record.contentSlot !== identity.contentSlot ||
      !(record.payload instanceof Uint8Array) ||
      ref.byteStart !== 0 ||
      ref.byteEnd !== record.payload.byteLength ||
      ref.orderStart !== 0 ||
      ref.orderEnd !== 0
    )
      throw new SyncProtocolError("MALFORMED_FRAME", { message: "text claim reference differs from committed record" });
    return true;
  } finally {
    loaded.doc.destroy();
  }
}

/** 建立消息声明：新写入走持久索引；索引前旧 live 块只沿当前代次权威链逐 Doc 读取一次。 */
export function createTextClaim(options: {
  readonly store: ProjectionStore;
  readonly scopeKey: string;
  readonly digest: DigestFn;
}): TextClaim {
  const { store } = options;
  const claimed = new Set<string>();
  let historicalEntries: ReadonlySet<string> | null = null;
  let historyLoad: Promise<ReadonlySet<string>> | null = null;
  let legacyEntries: ReadonlySet<string> | null = null;
  let legacyLoad: Promise<ReadonlySet<string>> | null = null;
  let generation: string | null = null;
  let epoch = Symbol();
  let lineage = createTextClaimLineage(store, options.scopeKey);

  async function loadHistoricalEntries(docIds: readonly string[], activeDocId: string): Promise<ReadonlySet<string>> {
    const entries = new Set<string>();
    for (const docId of docIds) {
      if (docId === activeDocId) continue;
      const state = await store.readDocStateAt(docId, 0);
      if (state === null) continue;
      const doc = new Y.Doc({ guid: docId });
      try {
        Y.applyUpdate(doc, state.snapshot);
        for (const record of records<StoredTextRecord>(doc)?.toArray() ?? []) {
          // 导入 text_part 使用数字槽位；保持按 entryId 对齐实时用户消息的既有契约。
          if (record.kind === "text_part" && typeof record.entryId === "string") entries.add(record.entryId);
        }
      } finally {
        doc.destroy();
      }
    }
    return entries;
  }

  return {
    async claim(input) {
      const claimEpoch = epoch;
      const claimLineage = lineage;
      const activeIdentity = parseDocId(input.activeDoc.guid);
      if (
        activeIdentity.kind !== "content" ||
        activeIdentity.generation !== input.generation ||
        (generation !== null && generation !== input.generation)
      )
        throw new SyncProtocolError("GENERATION_MISMATCH", {
          message: "text claim differs from its writer generation",
        });
      generation = input.generation;
      const key = textClaimKey(input.entryId, input.contentSlot);
      if (claimed.has(key)) return false;
      claimed.add(key);
      try {
        const active = records<StoredTextRecord>(input.activeDoc)?.toArray() ?? [];
        let exists = active.some(
          (record) =>
            record.kind === "text" && record.entryId === input.entryId && record.contentSlot === input.contentSlot,
        );
        if (!exists && input.historyDocIds.length > 0) {
          if (historicalEntries === null) {
            historyLoad ??= loadHistoricalEntries(input.historyDocIds, input.activeDoc.guid);
            const entries = await historyLoad;
            if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
            historicalEntries = entries;
          }
          exists = historicalEntries.has(input.entryId);
        }
        if (!exists) {
          exists = await indexedTextExists(
            store,
            options.digest,
            { ...options, ...input },
            claimLineage,
            input.activeDoc.guid,
          );
          if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
        }
        if (!exists) {
          if (legacyEntries === null) {
            legacyLoad ??= claimLineage.read(input.generation, input.activeDoc.guid).then((docIds) =>
              legacyLiveTextClaims({
                store,
                activeDocId: input.activeDoc.guid,
                docIds,
              }),
            );
            const entries = await legacyLoad;
            if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
            legacyEntries = entries;
          }
          exists = legacyEntries.has(key);
        }
        if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
        return !exists;
      } catch (error) {
        if (claimEpoch !== epoch) {
          if (isTextClaimInvalidated(error)) throw error;
          throw new TextClaimInvalidatedError(input.activeDoc.guid, error);
        }
        claimed.delete(key);
        if (historicalEntries === null) historyLoad = null;
        if (legacyEntries === null) legacyLoad = null;
        throw error;
      }
    },
    release(entryId, contentSlot) {
      claimed.delete(textClaimKey(entryId, contentSlot));
    },
    reset() {
      epoch = Symbol();
      claimed.clear();
      historicalEntries = null;
      historyLoad = null;
      legacyEntries = null;
      legacyLoad = null;
      generation = null;
      lineage = createTextClaimLineage(store, options.scopeKey);
    },
  };
}
