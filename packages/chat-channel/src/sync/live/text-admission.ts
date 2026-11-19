import type * as Y from "yjs";
import { SyncProtocolError } from "../protocol/errors";
import { isTextBatchNotWritten } from "./text-batch-commit";
import { isTextClaimInvalidated, type TextClaim } from "./text-claim";
import { textClaimKey } from "./text-claim-history";
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

/** 同一投影的在途接纳共享完整结果；结清即移除，不缓存正文或已完成的请求。 */
const pendingAdmissions = new WeakMap<
  TextClaim,
  {
    token: WriterAuthorityToken;
    entries: Map<string, Promise<void>>;
  }
>();

/** 声明和入 merge 共用一次接纳结果，保留原始拒绝以便同键调用者安全重试。 */
export function admitText(input: {
  readonly claim: TextClaim;
  readonly authority: WriterAuthority;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly snapshot: () => TextAdmissionSnapshot;
  readonly admit: (snapshot: TextAdmissionSnapshot) => Promise<void> | null;
}): Promise<void> {
  return coalesceAdmission(input, input.snapshot(), 0);
}

/** 旧投影重判同样进入新 token 的共享任务，旧回调只结清自己持有的 map。 */
function coalesceAdmission(
  input: Parameters<typeof admitText>[0],
  snapshot: TextAdmissionSnapshot,
  firstAttempt: number,
): Promise<void> {
  let pending = pendingAdmissions.get(input.claim);
  if (pending?.token !== snapshot.token) {
    pending = { token: snapshot.token, entries: new Map() };
    pendingAdmissions.set(input.claim, pending);
  }
  const key = textClaimKey(input.entryId, input.contentSlot);
  const existing = pending.entries.get(key);
  if (existing) return existing;
  const promise = admitClaim(input, snapshot, firstAttempt);
  const entries = pending.entries;
  entries.set(key, promise);
  const clear = () => {
    if (entries.get(key) === promise) entries.delete(key);
  };
  void promise.then(clear, clear);
  return promise;
}

/** 只有 merge 前的投影或尾块变化可以重新判定，错误不得越过原来的代次。 */
async function admitClaim(
  input: Parameters<typeof admitText>[0],
  initial: TextAdmissionSnapshot,
  firstAttempt: number,
): Promise<void> {
  let snapshot = initial;
  for (let attempt = firstAttempt; ; attempt++) {
    let accepted: boolean | undefined;
    let invalidation: unknown;
    let advanced: TextAdmissionSnapshot | undefined;
    try {
      accepted = await input.claim.claim({ ...snapshot, entryId: input.entryId, contentSlot: input.contentSlot });
    } catch (error) {
      if (!isTextClaimInvalidated(error)) {
        if (
          !(error instanceof SyncProtocolError) ||
          error.code !== "MALFORMED_FRAME" ||
          !input.authority.isInstalled(snapshot.token)
        )
          throw error;
        const current = input.snapshot();
        if (current.generation !== snapshot.generation || current.activeDoc.guid === snapshot.activeDoc.guid)
          throw error;
        advanced = current;
      }
      invalidation = error;
    }
    if (accepted && input.authority.isInstalled(snapshot.token)) {
      const current = input.snapshot();
      if (current.generation === snapshot.generation && current.activeDoc.guid !== snapshot.activeDoc.guid) {
        input.claim.release(input.entryId, input.contentSlot);
        advanced = current;
      }
    }
    if (invalidation === undefined && advanced === undefined && input.authority.isInstalled(snapshot.token)) {
      if (accepted) {
        await input.admit(snapshot);
        return;
      }
      try {
        await input.authority.confirm(snapshot.token, snapshot.generation);
        return;
      } catch (error) {
        if (input.authority.isCurrent(snapshot.token)) throw error;
        invalidation = error;
      }
    }
    await input.authority.settled();
    const current = advanced ?? input.snapshot();
    if (attempt > 0 || snapshot.generation !== current.generation)
      throw new SyncProtocolError("GENERATION_MISMATCH", {
        message: "text admission outlived its projection generation",
        retryable: true,
        ...(invalidation === undefined ? {} : { cause: invalidation }),
      });
    if (current.token !== snapshot.token) return coalesceAdmission(input, current, attempt + 1);
    snapshot = current;
  }
}
