import type * as Y from "yjs";
import type { AdmissionController } from "../capacity/admission";
import { WORKING_CREDIT, type WorkingCredit } from "../capacity/working-credit";
import type { DigestFn } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import type { ProjectionStore } from "../store/types";
import type { MergeKey } from "./merge-buffer";
import { isTextBatchNotWritten } from "./text-batch-commit";
import { createTextClaim, isTextClaimInvalidated, type TextClaim } from "./text-claim";
import { textClaimKey } from "./text-claim-history";
import type { TextClaimStore } from "./text-claim-store";
import type { WriterAuthority, WriterAuthorityToken } from "./writer-authority";
import type { WriterTextBarrier } from "./writer-text-barrier";

/** merge 接纳失败只回收本次尚未保留的幂等声明，已接纳窗口继续拥有原身份。 */
export function createTextInputAdmission(claim: TextClaim, barrier: WriterTextBarrier) {
  return (
    identity: Omit<MergeKey, "generation">,
    delta: string,
    generation: string,
    idempotent = false,
  ): Promise<void> | null => {
    try {
      return barrier.push({ generation, ...identity }, delta, idempotent);
    } catch (error) {
      if (idempotent && !barrier.retains(generation, identity.entryId, identity.contentSlot))
        claim.release(identity.entryId, identity.contentSlot);
      throw error;
    }
  };
}

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
  readonly pendingFlush: (snapshot: TextAdmissionSnapshot) => Promise<void> | null;
}): Promise<void> {
  return coalesceAdmission(input, input.snapshot(), 0);
}

/** 同代新 token 重放前重新核对 canonical；只有已提交身份和当前写权共同成立才能退休原正文。 */
export async function revalidateRetainedText(input: {
  readonly admission: AdmissionController;
  readonly store: ProjectionStore;
  readonly scopeKey: string;
  readonly digest: DigestFn;
  readonly credit: WorkingCredit;
  readonly authority: WriterAuthority;
  readonly token: WriterAuthorityToken;
  readonly key: MergeKey;
  readonly activeDoc: Y.Doc;
  readonly historyDocIds: readonly string[];
}): Promise<boolean> {
  const { authority, token, key } = input;
  authority.assertCurrent(token);
  if (token.generation !== key.generation)
    throw new SyncProtocolError("GENERATION_MISMATCH", { message: "retained text crosses its installed projection" });
  const temporary = createTextClaim({
    scopeKey: input.scopeKey,
    digest: input.digest,
    admission: {
      reserve(pool, bytes) {
        input.admission.assertWorkingCredit(input.credit);
        // reset 后的前驱规模只能在读取时确定；只补本次局部短缺，global 拒绝仍保留原正文和已有信用。
        if (pool === "controlIndex" && bytes > input.credit.availableBytes)
          input.credit.growTo(input.credit.totalBytes + bytes - input.credit.availableBytes);
        return input.admission.reserve(pool, bytes, input.credit);
      },
    },
    store: retainedClaimStore(input.store, input.credit),
  });
  try {
    const replay = await temporary.claim({ ...input, ...key });
    authority.assertCurrent(token);
    if (!replay) await authority.confirm(token, key.generation);
    return replay;
  } finally {
    temporary.reset();
  }
}

/** 独立只读转发面保留注入对象的 receiver，冻结方法不经 Proxy 包装。 */
function retainedClaimStore(store: ProjectionStore, credit: WorkingCredit): TextClaimStore {
  return {
    readGeneration: (...args) => store.readGeneration(...args),
    readSuccessor: (...args) => store.readSuccessor(...args),
    readDocStateAt: (...args) => store.readDocStateAt(...args),
    readUpdatesAfter: (...args) => store.readUpdatesAfter(...args),
    locateRefs: (...args) => store.locateRefs(...args),
    readLiveTextCoverage: (query) => store.readLiveTextCoverage({ ...query, [WORKING_CREDIT]: credit }),
  };
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
    if (input.authority.isInstalled(snapshot.token)) {
      const retained = input.pendingFlush(snapshot);
      if (retained !== null) {
        await retained;
        return;
      }
    }
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
      const pending = input.pendingFlush(snapshot);
      if (pending !== null) {
        await pending;
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
