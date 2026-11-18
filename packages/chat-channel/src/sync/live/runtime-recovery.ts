import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { scopeKey } from "../protocol/identity";
import type { WriterLease } from "../store/types";
import { captureSlice } from "./change-capture";
import { appendCommittedBatch, loadCommittedDoc } from "./committed-doc";
import { type Cursor, overflowOfSlices, RUNTIME_KIND, type Slice } from "./live-writer-internal";
import type { LiveWriterOptions } from "./live-writer-types";
import { createRuntimeDoc, type RuntimeEntityRecord } from "./runtime-doc";
import { buildPendingBatch } from "./writer-support";

/** 已验证的 runtime 路由只在后继首次更新前补齐交接，已有事件绝不重放前代。 */
export async function restoreRuntimeSuccessor(input: {
  readonly options: Pick<LiveWriterOptions, "store" | "scope" | "limits" | "capacity" | "random" | "digest">;
  readonly previousId: string;
  readonly nextId: string;
  readonly renew: () => Promise<WriterLease>;
  readonly stop: (code: SyncErrorCode, message: string, cause?: unknown) => SyncProtocolError;
}): Promise<void> {
  const { options, previousId, nextId } = input;
  const previous = await loadCommittedDoc(options.store, previousId);
  if (!previous) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "runtime predecessor is unavailable" });
  let carried: readonly RuntimeEntityRecord[];
  try {
    carried = createRuntimeDoc(RUNTIME_KIND, options.limits, previous.doc).exportForRotation();
  } finally {
    previous.doc.destroy();
  }
  const next = await loadCommittedDoc(options.store, nextId);
  if (!next) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "runtime successor is unavailable" });
  try {
    if (next.lastSeq !== 0) return;
    const target = createRuntimeDoc(RUNTIME_KIND, options.limits, next.doc);
    const existing = target.exportForRotation();
    if (existing.length > 0) {
      const byId = new Map(existing.map((record) => [record.entityId, JSON.stringify(record)]));
      if (
        existing.length !== carried.length ||
        carried.some((record) => byId.get(record.entityId) !== JSON.stringify(record))
      )
        throw input.stop("DIGEST_CONFLICT", "runtime successor base differs from its transfer");
      return;
    }
    if (carried.length === 0) return;
    const cursor: Cursor = { docId: nextId, kind: RUNTIME_KIND, ...next };
    const slices: Slice[] = [];
    captureSlice(slices, cursor, () => {
      for (const record of carried) target.upsertEntity(record);
    });
    const overflow = overflowOfSlices({
      slices,
      recordBytes: 0,
      capacity: options.capacity,
      runtimeHardLimitBytes: options.limits.hardLimitBytes,
      cursorOf: () => cursor,
    });
    if (overflow !== null) throw input.stop("CAPACITY_EXCEEDED", "runtime successor transfer exceeds the hard limit");
    await appendCommittedBatch({
      store: options.store,
      scopeKey: scopeKey(options.scope),
      batch: buildPendingBatch(slices, options.random, options.digest),
      cursors: new Map([[nextId, cursor]]),
      renew: input.renew,
      stop: input.stop,
    });
  } finally {
    next.doc.destroy();
  }
}
