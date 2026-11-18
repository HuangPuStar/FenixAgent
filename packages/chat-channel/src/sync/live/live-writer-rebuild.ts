import type { SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import type { DocKind } from "../protocol/identity";
import type { WriterLease } from "../store/types";
import { loadCommittedDoc } from "./committed-doc";
import { ensureWritableContentDoc } from "./content-tail";
import type { DirectoryAppender } from "./directory-appender";
import { recoverLiveSuccessors } from "./live-successor";
import { CONTENT_KIND, type Cursor, fail, RUNTIME_KIND } from "./live-writer-internal";
import type { LiveWriterOptions } from "./live-writer-types";
import { restoreRuntimeSuccessor } from "./runtime-recovery";
import type { SealingMachine } from "./sealing";

/** 重建只准备当前代次的权威入口，全部成功后由 writer 一次接管这些游标。 */
export async function rebuildLiveProjection(input: {
  readonly options: LiveWriterOptions;
  readonly scopeKey: string;
  readonly lease: WriterLease;
  readonly sealing: SealingMachine;
  readonly directory: DirectoryAppender;
  readonly renew: () => Promise<WriterLease>;
  readonly stop: (code: SyncErrorCode, message: string, cause?: unknown) => SyncProtocolError;
}): Promise<{ generation: string; historyContentDocIds: readonly string[]; cursors: ReadonlyMap<DocKind, Cursor> }> {
  const { options, scopeKey, lease, directory, sealing } = input;
  const pointer = await options.store.readScopePointer(scopeKey);
  const generationId = pointer?.currentGeneration ?? fail("GENERATION_MISMATCH", "scope has no current generation");
  const generation = await options.store.readGeneration(scopeKey, generationId);
  if (!generation) fail("GENERATION_MISMATCH", "current generation record is missing");
  if (["retired", "failed"].includes(generation.state)) fail("RESOURCE_RETIRED", generationId);
  const succession = { store: options.store, scope: options.scope, lease, sealing, admission: options.admission };
  const cursors = new Map<DocKind, Cursor>();
  async function load(docId: string, kind: DocKind): Promise<void> {
    const loaded = await loadCommittedDoc(options.store, docId);
    if (!loaded) fail("DOC_NOT_FOUND", "document has no committed base state");
    cursors.set(kind, { docId, kind, ...loaded });
  }
  try {
    const runtimeDocId = await recoverLiveSuccessors({
      ...succession,
      startDocId: generation.entryRefs.runtimeDocId,
      onSuccessor: (previousId, nextId) =>
        restoreRuntimeSuccessor({
          options,
          previousId,
          nextId,
          renew: input.renew,
          stop: input.stop,
        }),
    });
    await load(runtimeDocId, RUNTIME_KIND);
    await directory.load(lease, generation.generation, generation.entryRefs);
    const closureTail = generation.entryRefs.contentDocIds.at(-1);
    if (!closureTail) fail("DOC_NOT_FOUND", "generation has no content block entry");
    const contentDocId = await ensureWritableContentDoc({
      ...succession,
      directory,
      scopeKey,
      generation: generation.generation,
      importEndOrdinal: generation.importEndOrdinal ?? 0,
      closureTailDocId: closureTail,
      digest: options.digest,
    });
    await load(contentDocId, CONTENT_KIND);
    return {
      generation: generation.generation,
      historyContentDocIds: (generation.importEndOrdinal ?? 0) > 0 ? generation.entryRefs.contentDocIds : [],
      cursors,
    };
  } catch (error) {
    for (const cursor of cursors.values()) cursor.doc.destroy();
    throw error;
  }
}
