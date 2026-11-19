import type * as Y from "yjs";
import type { AdmissionController, Reservation } from "../capacity/admission";
import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import { parseDocId } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";
import type { LiveRecordValue } from "./live-writer-types";
import { TextClaimCache } from "./text-claim-cache";
import { legacyLiveTextClaims, type StoredTextRecord, textClaimKey } from "./text-claim-history";
import { type TextClaimIdentity, textClaimLookupId } from "./text-claim-identity";
import { createTextClaimLineage, type TextClaimLineage } from "./text-claim-lineage";
import { readTextClaimDoc } from "./text-claim-read";
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
  admission: AdmissionController,
  assertCurrent: () => void,
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
  const exists = await readTextClaimDoc({
    store,
    admission,
    docId: ref.docId,
    assertCurrent,
    consume(doc) {
      const record = records<LiveRecordValue>(doc)
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
        throw new SyncProtocolError("MALFORMED_FRAME", {
          message: "text claim reference differs from committed record",
        });
      return true;
    },
  });
  if (exists === null)
    throw new SyncProtocolError("DOC_NOT_FOUND", { message: "text claim reference has no committed state" });
  return exists;
}

/** 建立消息声明：新写入走持久索引；索引前旧 live 块只沿当前代次权威链逐 Doc 读取一次。 */
export function createTextClaim(options: {
  readonly store: ProjectionStore;
  readonly scopeKey: string;
  readonly digest: DigestFn;
  readonly admission: AdmissionController;
}): TextClaim {
  const { store } = options;
  const claimed = new TextClaimCache(options.admission);
  const pending = new Map<string, Promise<boolean>>();
  const historicalEntries = new TextClaimCache(options.admission);
  let historyLoaded = false;
  let historyLoad: Promise<void> | null = null;
  const legacyEntries = new TextClaimCache(options.admission);
  let legacyTailDocId: string | null = null;
  let legacyLoad: { docId: string; promise: Promise<void> } | null = null;
  let generation: string | null = null;
  let epoch = Symbol();
  let lineage = createTextClaimLineage(store, options.scopeKey, options.admission);

  /** 导入槽位按 entryId 判重；边读边计费，旧读取不能越过 reset 恢复缓存。 */
  async function loadHistoricalEntries(
    docIds: readonly string[],
    activeDocId: string,
    claimEpoch: symbol,
  ): Promise<void> {
    for (const docId of docIds) {
      if (docId === activeDocId) continue;
      const loaded = await readTextClaimDoc({
        store,
        admission: options.admission,
        docId,
        assertCurrent() {
          if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(activeDocId);
        },
        consume(doc) {
          for (const record of records<StoredTextRecord>(doc)?.toArray() ?? []) {
            // 导入 text_part 使用数字槽位；保持按 entryId 对齐实时用户消息的既有契约。
            if (record.kind === "text_part" && typeof record.entryId === "string")
              historicalEntries.add(record.entryId);
          }
        },
      });
      if (loaded === null)
        throw new SyncProtocolError("DOC_NOT_FOUND", { message: "text claim history document has no committed state" });
    }
  }

  /** 每次只补已扫描尾块之后的新封口范围；不同目标在前次失败后仍可独立读取。 */
  function loadLegacy(input: Parameters<TextClaim["claim"]>[0], claimEpoch: symbol, claimLineage: TextClaimLineage) {
    if (legacyLoad?.docId === input.activeDoc.guid) return legacyLoad.promise;
    const inspect = async () => {
      const docIds = await claimLineage.predecessors(input.generation, input.activeDoc.guid, legacyTailDocId);
      if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
      await legacyLiveTextClaims({
        store,
        admission: options.admission,
        scopeKey: options.scopeKey,
        generation: input.generation,
        activeDocId: input.activeDoc.guid,
        docIds: new Set(docIds),
        assertCurrent() {
          if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
        },
        accept(key) {
          if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
          legacyEntries.add(key);
        },
      });
      if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
      legacyTailDocId = input.activeDoc.guid;
    };
    const promise = legacyLoad ? legacyLoad.promise.then(inspect, inspect) : inspect();
    const current = { docId: input.activeDoc.guid, promise };
    legacyLoad = current;
    const clear = () => {
      if (legacyLoad === current) legacyLoad = null;
    };
    void promise.then(clear, clear);
    return promise;
  }

  /** 等待中的同键调用也必须使用本投影的 content Doc，不能借首调用绕过身份校验。 */
  function assertActiveWriterDoc(input: Parameters<TextClaim["claim"]>[0]): void {
    const activeIdentity = parseDocId(input.activeDoc.guid);
    if (
      activeIdentity.kind !== "content" ||
      activeIdentity.generation !== input.generation ||
      (generation !== null && generation !== input.generation)
    )
      throw new SyncProtocolError("GENERATION_MISMATCH", {
        message: "text claim differs from its writer generation",
      });
  }

  /** 所有判重依据属于同一投影生命周期；仅成功判定才保留身份占位。 */
  async function evaluate(input: Parameters<TextClaim["claim"]>[0]): Promise<boolean> {
    const claimEpoch = epoch;
    const claimLineage = lineage;
    assertActiveWriterDoc(input);
    const key = textClaimKey(input.entryId, input.contentSlot);
    if (claimed.has(key)) return false;
    claimed.add(key);
    generation = input.generation;
    try {
      const active = records<StoredTextRecord>(input.activeDoc)?.toArray() ?? [];
      let exists = active.some(
        (record) =>
          record.kind === "text" && record.entryId === input.entryId && record.contentSlot === input.contentSlot,
      );
      if (!exists && input.historyDocIds.length > 0) {
        if (!historyLoaded) {
          historyLoad ??= loadHistoricalEntries(input.historyDocIds, input.activeDoc.guid, claimEpoch);
          await historyLoad;
          if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
          historyLoaded = true;
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
          options.admission,
          () => {
            if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
          },
        );
        if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
      }
      if (!exists) {
        if (legacyTailDocId !== input.activeDoc.guid) {
          await loadLegacy(input, claimEpoch, claimLineage);
          if (claimEpoch !== epoch) throw new TextClaimInvalidatedError(input.activeDoc.guid);
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
      if (!historyLoaded) {
        historyLoad = null;
        historicalEntries.clear();
      }
      throw error;
    }
  }

  return {
    claim(input) {
      try {
        assertActiveWriterDoc(input);
      } catch (error) {
        return Promise.reject(error);
      }
      const key = JSON.stringify([input.generation, input.entryId, input.contentSlot]);
      const existing = pending.get(key);
      if (existing) return existing.then(() => false);
      let inFlight: Reservation;
      try {
        let metadataBytes = 512 + key.length * 4 + input.generation.length * 2 + input.activeDoc.guid.length * 2;
        for (const docId of input.historyDocIds) metadataBytes += 16 + docId.length * 2;
        inFlight = options.admission.reserve("controlIndex", metadataBytes);
      } catch (error) {
        return Promise.reject(error);
      }
      // reset 只失效已安装缓存；等待 Store 的输入仍存活，必须由原任务结清后归还。
      const promise = evaluate(input).finally(() => inFlight.release());
      pending.set(key, promise);
      const clear = () => {
        if (pending.get(key) === promise) pending.delete(key);
      };
      void promise.then(clear, clear);
      return promise;
    },
    release(entryId, contentSlot) {
      claimed.delete(textClaimKey(entryId, contentSlot));
    },
    reset() {
      epoch = Symbol();
      claimed.clear();
      pending.clear();
      historicalEntries.clear();
      historyLoaded = false;
      historyLoad = null;
      legacyEntries.clear();
      legacyTailDocId = null;
      legacyLoad = null;
      generation = null;
      lineage.clear();
      lineage = createTextClaimLineage(store, options.scopeKey, options.admission);
    },
  };
}
