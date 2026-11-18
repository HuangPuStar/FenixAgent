import { SyncProtocolError } from "../protocol/errors";
import { parseDocId } from "../protocol/identity";
import type { ProjectionStore } from "../store/types";
import { liveContentTailDocId } from "./content-tail-identity";

/** 文本索引只能指向从当前代次入口沿唯一 successor 路由可达的 live 内容块。 */
export interface TextClaimLineage {
  read(generation: string, activeDocId: string): Promise<ReadonlySet<string>>;
}

/** 只缓存文档身份；尾部增长时沿旧尾增量预检，不读取前驱正文或扫描同代次孤块。 */
export function createTextClaimLineage(store: ProjectionStore, scopeKey: string): TextClaimLineage {
  let cache: { generation: string; tailDocId: string; docs: Set<string> } | null = null;
  let pending: { generation: string; activeDocId: string; promise: Promise<ReadonlySet<string>> } | null = null;

  async function inspect(generationId: string, activeDocId: string): Promise<ReadonlySet<string>> {
    if (cache?.generation === generationId && cache.docs.has(activeDocId)) return cache.docs;
    const active = parseDocId(activeDocId);
    if (active.kind !== "content" || active.generation !== generationId)
      throw new SyncProtocolError("GENERATION_MISMATCH", { message: "text claim tail differs from generation" });
    let docId: string;
    const previous = cache?.generation === generationId ? cache : null;
    if (previous) docId = previous.tailDocId;
    else {
      const generation = await store.readGeneration(scopeKey, generationId);
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
        for (const id of extension) docs.add(id);
        cache = { generation: generationId, tailDocId: activeDocId, docs };
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

  return {
    read(generation, activeDocId) {
      if (pending?.generation === generation && pending.activeDocId === activeDocId) return pending.promise;
      const promise = pending
        ? pending.promise.then(() => inspect(generation, activeDocId))
        : inspect(generation, activeDocId);
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
}
