import type { AdmissionBudget } from "../capacity/admission";
import { SyncProtocolError } from "../protocol/errors";
import { parseDocId } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";
import { liveContentTailDocId } from "./content-tail-identity";
import { TextClaimCache } from "./text-claim-cache";

/** 文本索引只能指向从当前代次入口沿唯一 successor 路由可达的 live 内容块。 */
export interface TextClaimLineage {
  read(generation: string, activeDocId: string): Promise<ReadonlySet<string>>;
  /** 返回上次已扫描尾块到当前尾块之前的新封口范围，不遍历已经覆盖的前缀。 */
  predecessors(generation: string, activeDocId: string, fromDocId: string | null): Promise<readonly string[]>;
  /** 投影关闭或重建后归还链身份额度，并使在途读取不能恢复旧缓存。 */
  clear(): void;
  /** 已读取链身份实际持有的额度，不重新遍历 Store。 */
  reservedBytes(): number;
}

/** 只缓存文档身份；尾部增长时沿旧尾增量预检，不读取前驱正文或扫描同代次孤块。 */
export function createTextClaimLineage(
  store: ProjectionStore,
  scopeKey: string,
  admission: AdmissionBudget,
): TextClaimLineage {
  const identities = new TextClaimCache(admission);
  let epoch = Symbol();
  let cache: {
    generation: string;
    tailDocId: string;
    docs: Set<string>;
    ordered: string[];
    positions: Map<string, number>;
  } | null = null;
  let pending: { generation: string; activeDocId: string; promise: Promise<ReadonlySet<string>> } | null = null;

  async function inspect(generationId: string, activeDocId: string): Promise<ReadonlySet<string>> {
    const readEpoch = epoch;
    const assertCurrent = () => {
      if (readEpoch !== epoch)
        throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim lineage was cleared" });
    };
    if (cache?.generation === generationId && cache.docs.has(activeDocId))
      return cache.tailDocId === activeDocId
        ? cache.docs
        : new Set(cache.ordered.slice(0, (cache.positions.get(activeDocId) ?? -1) + 1));
    const active = parseDocId(activeDocId);
    if (active.kind !== "content" || active.generation !== generationId)
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim tail differs from generation" });
    let docId: string;
    const previous = cache?.generation === generationId ? cache : null;
    if (previous) docId = previous.tailDocId;
    else {
      const generation = await store.readGeneration(scopeKey, generationId);
      assertCurrent();
      if (
        generation?.state !== "committed" ||
        generation.scopeKey !== scopeKey ||
        generation.generation !== generationId
      )
        throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim generation is not readable" });
      const closureTail = generation.entryRefs.contentDocIds.at(-1);
      if (!closureTail) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "text claim has no content entry" });
      docId = (generation.importEndOrdinal ?? 0) > 0 ? liveContentTailDocId(closureTail) : closureTail;
    }
    const extension: string[] = [];
    for (;;) {
      const identity = parseDocId(docId);
      const state = await store.readSuccessor(scopeKey, docId);
      assertCurrent();
      if (!state) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "text claim lineage is unavailable" });
      if (
        state.scopeKey !== scopeKey ||
        state.docId !== docId ||
        state.generation !== generationId ||
        state.kind !== "content" ||
        identity.generation !== generationId ||
        identity.kind !== "content"
      )
        throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim lineage crosses its authority" });
      extension.push(docId);
      if (docId === activeDocId) {
        const docs = previous?.docs ?? new Set<string>();
        const ordered = previous?.ordered ?? [];
        const positions = previous?.positions ?? new Map<string, number>();
        const added: string[] = [];
        try {
          for (const id of extension) {
            if (identities.has(id)) continue;
            identities.add(id);
            added.push(id);
          }
        } catch (error) {
          for (const id of added) identities.delete(id);
          throw error;
        }
        for (const id of extension) {
          if (docs.has(id)) continue;
          positions.set(id, ordered.length);
          ordered.push(id);
          docs.add(id);
        }
        cache = { generation: generationId, tailDocId: activeDocId, docs, ordered, positions };
        return docs;
      }
      if ((state.state !== "sealed" && state.state !== "sealing") || !state.route)
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "text claim predecessor has no committed route" });
      const next = parseDocId(state.route.successorDocId);
      if (
        next.kind !== "content" ||
        next.generation !== generationId ||
        next.blockIndex !== identity.blockIndex + 1 ||
        next.blockIndex > active.blockIndex
      )
        throw new SyncProtocolError("MALFORMED_FRAME", {
          message: "text claim lineage does not reach its active tail",
        });
      docId = state.route.successorDocId;
    }
  }

  const lineage: TextClaimLineage = {
    reservedBytes: () => identities.reservedBytes,
    clear() {
      epoch = Symbol();
      identities.clear();
      cache = null;
      pending = null;
    },
    async predecessors(generation, activeDocId, fromDocId) {
      await lineage.read(generation, activeDocId);
      const current = cache;
      const start = fromDocId === null ? 0 : current?.positions.get(fromDocId);
      const end = current?.positions.get(activeDocId);
      if (current?.generation !== generation || start === undefined || end === undefined || start > end)
        throw new SyncProtocolError("MALFORMED_FRAME", { message: "text claim coverage is outside its live lineage" });
      return current.ordered.slice(start, end);
    },
    read(generation, activeDocId) {
      if (pending?.generation === generation && pending.activeDocId === activeDocId) return pending.promise;
      const queuedEpoch = epoch;
      const inspectCurrent = () => {
        if (queuedEpoch !== epoch)
          throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim lineage was cleared" });
        return inspect(generation, activeDocId);
      };
      const promise = pending ? pending.promise.then(inspectCurrent, inspectCurrent) : inspectCurrent();
      const current = { generation, activeDocId, promise };
      pending = current;
      void promise.then(
        () => {
          if (pending === current) pending = null;
        },
        () => {
          if (pending === current) pending = null;
        },
      );
      return promise;
    },
  };
  return lineage;
}
