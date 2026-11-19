import { WORKING_CREDIT, type WorkingCredit } from "../capacity/working-credit";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import { createBatchId } from "../protocol/identity";
import type { WriterLease } from "../store/types";
import { appendCommittedBatch } from "./committed-doc";
import type { DirectoryAppender } from "./directory-appender";
import type { Cursor } from "./live-writer-internal";
import type { LiveRecordValue, LiveWriterOptions } from "./live-writer-types";
import type { MergeFlushRequest } from "./merge-buffer";
import { planLiveTextBatch, type TextBatchPlan } from "./text-batch-plan";
import { textClaimRef } from "./text-claim-identity";
import { bytes, records } from "./writer-support";

const notWritten = new WeakSet<object>();

/** 仅规划边界或原子 Store 异常契约证明未写的失败可以释放声明，外围错误码不提供该保证。 */
export function isTextBatchNotWritten(error: unknown): boolean {
  return typeof error === "object" && error !== null && notWritten.has(error);
}

function markNotWritten(error: unknown): never {
  // Store adapter 可以复用异常实例；未写证明属于本次尝试，不能贴在共享的原始异常上。
  const refusal =
    error instanceof SyncProtocolError
      ? new SyncProtocolError(error.code, {
          message: error.message,
          retryable: error.retryable,
          safeContext: error.toFrameContext(),
          cause: error,
        })
      : new Error("text batch was not written", { cause: error });
  notWritten.add(refusal);
  throw refusal;
}

/** 整个物理计划固定身份和摘要，复用既有未知提交探测，禁止重新规划已发出的批次。 */
export async function commitPlannedTextBatch(input: {
  readonly workingCredit?: WorkingCredit;
  readonly options: LiveWriterOptions;
  readonly scopeKey: string;
  readonly generation: string;
  readonly plan: TextBatchPlan;
  readonly renew: () => Promise<WriterLease>;
  readonly stop: (code: SyncErrorCode, message: string, cause?: unknown) => SyncProtocolError;
}): Promise<void> {
  const { options, plan } = input;
  const batchId = createBatchId(options.random);
  const record = records<LiveRecordValue>(plan.finalCursor.doc)?.toArray().at(-1);
  if (record?.kind !== "text")
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "text plan has no final text record" });
  const refs = [
    textClaimRef(
      options.digest,
      {
        scopeKey: input.scopeKey,
        generation: input.generation,
        entryId: record.entryId,
        contentSlot: record.contentSlot,
      },
      plan.finalCursor.docId,
      record,
    ),
  ];
  const digest = options.digest(
    bytes(
      JSON.stringify({
        version: 1,
        generation: input.generation,
        expectedPointerRevision: plan.expectedPointerRevision,
        updates: plan.slices.map((slice) => ({ ...slice, bytes: options.digest(slice.bytes) })),
        newDocs: plan.newDocs.map((doc) => ({ ...doc, snapshot: options.digest(doc.snapshot) })),
        seals: plan.seals.map((seal) => ({ ...seal, finalSnapshot: options.digest(seal.finalSnapshot) })),
        refs,
      }),
    ),
  );
  const batch = { batchId, slices: plan.slices, digest, refs };
  let storeEntered = false;
  try {
    await appendCommittedBatch({
      store: options.store,
      scopeKey: input.scopeKey,
      batch,
      cursors: plan.cursors,
      renew: input.renew,
      stop: input.stop,
      append: async (append) => {
        const frontiers = [...append.expectedFrontiers];
        // 首片之前即可轮换满块；该旧块虽无新 update，封口仍须比较原前沿。
        for (const seal of plan.seals)
          if (!frontiers.some((frontier) => frontier.docId === seal.docId))
            frontiers.push({ docId: seal.docId, lastSeq: seal.finalSeq });
        storeEntered = true;
        try {
          return await options.store.commitContentBatch({
            [WORKING_CREDIT]: input.workingCredit,
            ...append,
            expectedFrontiers: frontiers,
            generation: input.generation,
            newDocs: [...plan.newDocs],
            seals: [...plan.seals],
            expectedPointerRevision: plan.expectedPointerRevision,
          });
        } catch (error) {
          // 原子 Store 的 throw 保证未写；先前 unknown 仍由外层批次状态机升级为未知结果。
          if (
            error instanceof SyncProtocolError &&
            (error.code === "ADMISSION_REJECTED" ||
              error.code === "LEASE_EXPIRED" ||
              error.code === "WRITER_EPOCH_LOST")
          ) {
            markNotWritten(error);
          }
          throw error;
        }
      },
    });
  } catch (error) {
    if (!storeEntered) markNotWritten(error);
    throw error;
  }
}

/** 规划与提交共同持有临时资源；只有明确成功后才交付末块游标与目录缓存。 */
export async function writeAtomicText(input: {
  readonly workingCredit?: WorkingCredit;
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
  }).catch(markNotWritten);
  try {
    await commitPlannedTextBatch({ ...input, plan });
    plan.commit();
    return plan.finalCursor;
  } finally {
    plan.dispose();
  }
}
