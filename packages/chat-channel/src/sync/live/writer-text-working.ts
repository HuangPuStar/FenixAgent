import type { AdmissionController } from "../capacity/admission";
import type { SyncCapacityProfile } from "../capacity/profile";
import { textWorkingChunkCount, textWorkingControlBytes } from "../capacity/text-plan-reservations";
import type { WorkingCredit } from "../capacity/working-credit";
import type { DirectoryAppender } from "./directory-appender";
import type { Cursor } from "./live-writer-internal";
import type { LiveWriterOptions } from "./live-writer-types";
import type { MergeFlushRequest, MergeKey } from "./merge-buffer";
import { revalidateRetainedText } from "./text-admission";
import type { TextClaim } from "./text-claim";
import type { WriterAuthority, WriterAuthorityToken } from "./writer-authority";
import { WriterTextBarrier } from "./writer-text-barrier";

/** 只依据当前局部游标与本scope已加载身份估算，不能因其他scope历史索引大小扩大工作集。 */
export function createTextWorkingEstimator(input: {
  readonly capacity: SyncCapacityProfile;
  readonly scopeKey: string;
  readonly directory: DirectoryAppender;
  readonly content: () => Cursor;
  readonly claim: TextClaim;
  readonly history: () => readonly string[];
}) {
  let history: readonly string[] | null = null;
  let historyBytes = 0;
  return (key: MergeKey, textBytes: number, aheadChunks: number, idempotent: boolean): number => {
    const content = input.content(),
      directory = input.directory.workingFrontier();
    // 入口闭包只在rebuild整体替换；普通token不读取claim/history，幂等窗口每次安装只汇总一次。
    if (idempotent && history !== input.history()) {
      history = input.history();
      historyBytes = 0;
      for (const id of history) historyBytes += 16 + id.length * 2;
    }
    return textWorkingControlBytes({
      inputs: input.capacity.inputs,
      scopeUnits: input.scopeKey.length,
      generationUnits: key.generation.length,
      textBytes,
      aheadChunks,
      idempotent,
      state: {
        ...directory,
        contentLastSeq: content.lastSeq,
        docIdUnits: Math.max(content.docId.length, directory.docIdUnits),
        claimControlBytes: idempotent ? input.claim.reservedControlBytes() + historyBytes : 0,
      },
    });
  };
}

/** 把工作额度、重判预算和FIFO交给同一owner，writer只保留生命周期与提交回调。 */
export function createTextWorkQueue(
  input: Omit<Parameters<typeof createTextWorkingEstimator>[0], "capacity"> & {
    readonly options: LiveWriterOptions & { readonly admission: AdmissionController };
    readonly authority: WriterAuthority;
    readonly write: (request: MergeFlushRequest, token: WriterAuthorityToken, credit: WorkingCredit) => Promise<void>;
    readonly onFailure: (error: unknown) => void;
  },
): WriterTextBarrier {
  return new WriterTextBarrier({
    admission: input.options.admission,
    clock: input.options.clock,
    merge: input.options.merge,
    capture: () => input.authority.captureTask(),
    enqueue: (task) => input.authority.enqueue(task),
    write: input.write,
    isCurrent: (token) => input.authority.isCurrent(token),
    onFailure: input.onFailure,
    workingBytes: createTextWorkingEstimator({ ...input, capacity: input.options.capacity }),
    chunkCount: (bytes) => textWorkingChunkCount(input.options.capacity.inputs, bytes),
    shouldReplay: (key, token, credit) =>
      revalidateRetainedText({
        ...input.options,
        scopeKey: input.scopeKey,
        credit,
        authority: input.authority,
        token,
        key,
        activeDoc: input.content().doc,
        historyDocIds: input.history(),
      }),
  });
}
