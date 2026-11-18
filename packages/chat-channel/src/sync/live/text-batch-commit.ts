import type { SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { createBatchId } from "../protocol/identity";
import type { WriterLease } from "../store/types";
import { appendCommittedBatch } from "./committed-doc";
import type { DirectoryAppender } from "./directory-appender";
import type { Cursor } from "./live-writer-internal";
import type { LiveWriterOptions } from "./live-writer-types";
import type { MergeFlushRequest } from "./merge-buffer";
import { planLiveTextBatch, type TextBatchPlan } from "./text-batch-plan";
import { bytes } from "./writer-support";

/** 整个物理计划固定身份和摘要，复用既有未知提交探测，禁止重新规划已发出的批次。 */
export async function commitPlannedTextBatch(input: {
  readonly options: LiveWriterOptions;
  readonly scopeKey: string;
  readonly generation: string;
  readonly plan: TextBatchPlan;
  readonly renew: () => Promise<WriterLease>;
  readonly stop: (code: SyncErrorCode, message: string, cause?: unknown) => SyncProtocolError;
}): Promise<void> {
  const { options, plan } = input;
  const batchId = createBatchId(options.random);
  const digest = options.digest(
    bytes(
      JSON.stringify({
        version: 1,
        generation: input.generation,
        expectedPointerRevision: plan.expectedPointerRevision,
        updates: plan.slices.map((slice) => ({ ...slice, bytes: options.digest(slice.bytes) })),
        newDocs: plan.newDocs.map((doc) => ({ ...doc, snapshot: options.digest(doc.snapshot) })),
        seals: plan.seals.map((seal) => ({ ...seal, finalSnapshot: options.digest(seal.finalSnapshot) })),
      }),
    ),
  );
  const batch = { batchId, slices: plan.slices, digest };
  await appendCommittedBatch({
    store: options.store,
    scopeKey: input.scopeKey,
    batch,
    cursors: plan.cursors,
    renew: input.renew,
    stop: input.stop,
    append: (append) => {
      const frontiers = [...append.expectedFrontiers];
      // 首片之前即可轮换满块；该旧块虽无新 update，封口仍须比较原前沿。
      for (const seal of plan.seals)
        if (!frontiers.some((frontier) => frontier.docId === seal.docId))
          frontiers.push({ docId: seal.docId, lastSeq: seal.finalSeq });
      return options.store.commitContentBatch({
        ...append,
        expectedFrontiers: frontiers,
        generation: input.generation,
        newDocs: [...plan.newDocs],
        seals: [...plan.seals],
        expectedPointerRevision: plan.expectedPointerRevision,
      });
    },
  });
}

/** 规划与提交共同持有临时资源；只有明确成功后才交付末块游标与目录缓存。 */
export async function writeAtomicText(input: {
  readonly options: LiveWriterOptions;
  readonly scopeKey: string;
  readonly generation: string;
  readonly request: MergeFlushRequest;
  readonly cursor: Cursor;
  readonly directory: DirectoryAppender;
  readonly renew: () => Promise<WriterLease>;
  readonly stop: (code: SyncErrorCode, message: string, cause?: unknown) => SyncProtocolError;
}): Promise<Cursor> {
  const plan = await planLiveTextBatch({
    ...input.options,
    request: input.request,
    cursor: input.cursor,
    scopeKey: input.scopeKey,
    generation: input.generation,
    directory: input.directory,
    maxFlushBytes: input.options.capacity.inputs.maxRawAcpFrameBytes + input.options.merge.maxBytes - 1,
  });
  try {
    await commitPlannedTextBatch({ ...input, plan });
    plan.commit();
    return plan.finalCursor;
  } finally {
    plan.dispose();
  }
}
