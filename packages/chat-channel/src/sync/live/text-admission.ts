import type * as Y from "yjs";
import { SyncProtocolError } from "../protocol/errors";
import { isTextBatchNotWritten } from "./text-batch-commit";
import { isTextClaimInvalidated, type TextClaim } from "./text-claim";
import type { WriterAuthority, WriterAuthorityToken } from "./writer-authority";

/** claim 的读取面必须与同一已安装投影绑定。 */
export interface TextAdmissionSnapshot {
  readonly token: WriterAuthorityToken;
  readonly generation: string;
  readonly activeDoc: Y.Doc;
  readonly historyDocIds: readonly string[];
}

/** 只有已证明未写入的容量拒绝可以释放声明并重试完整输入。 */
export function isRetryableTextRefusal(error: unknown): boolean {
  return isTextBatchNotWritten(error) && error instanceof SyncProtocolError && error.code === "ADMISSION_REJECTED";
}

/** 声明与缓冲接纳共用同步边界；只有 merge 前的失效可同代次重判一次。 */
export async function admitText(input: {
  readonly claim: TextClaim;
  readonly authority: WriterAuthority;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly snapshot: () => TextAdmissionSnapshot;
  readonly admit: (snapshot: TextAdmissionSnapshot) => Promise<void> | null;
}): Promise<void> {
  let snapshot = input.snapshot();
  for (let attempt = 0; ; attempt++) {
    let accepted: boolean | undefined;
    let invalidation: unknown;
    try {
      accepted = await input.claim.claim({ ...snapshot, entryId: input.entryId, contentSlot: input.contentSlot });
    } catch (error) {
      if (!isTextClaimInvalidated(error)) throw error;
      invalidation = error;
    }
    if (invalidation === undefined && input.authority.isInstalled(snapshot.token)) {
      if (accepted) {
        await input.admit(snapshot);
        return;
      }
      try {
        await input.authority.confirm(snapshot.token, snapshot.generation);
        return;
      } catch (error) {
        if (input.authority.isInstalled(snapshot.token)) throw error;
        invalidation = error;
      }
    }
    await input.authority.settled();
    const current = input.snapshot();
    if (attempt > 0 || snapshot.generation !== current.generation)
      throw new SyncProtocolError("GENERATION_MISMATCH", {
        message: "text admission outlived its projection generation",
        retryable: true,
        ...(invalidation === undefined ? {} : { cause: invalidation }),
      });
    snapshot = current;
  }
}
