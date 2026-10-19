// packages/chat-channel/src/state/doc-open-fence.ts
// open 生命周期的栅栏协调：快路径复核、水合失败收口、安装前的 close / 换代判定。
//
// 全部为无状态函数；fences、Doc Map、Redis 获取器与广播/错误端口由 DocOpenService 注入，
// 确保 close / replace 与 open 观察的是 DocManager 持有的同一份 fence 登记。

import type { Cluster, Redis } from "ioredis";
import type { Doc as YDoc } from "yjs";
import { getActiveGeneration } from "../persist/redis";
import type { ChatDoc, SessionDoc } from "../types";
import { SnapshotHydrationError } from "./factory";
import type { FenceSnapshot, ProjectionDocKind, ProjectionFences } from "./projection-fence";

export interface DocOpenFenceDeps {
  /** 与 DocManager.closeAll / replaceProjection 共享的同一实例。 */
  readonly fences: ProjectionFences;
  readonly getRedis: () => Redis | Cluster | null;
  readonly onError?: (context: string, err: unknown) => void;
  readonly registerDocBroadcast: (ydoc: YDoc, docName: string) => void;
}

/**
 * 已驻留 Doc 的快路径复核结果。
 * `stale` 携带复核起点的 fence 快照：重载期间 close 可能落在 map 删除之后、内部快照
 * 捕获之前，只有这份快照能观察到那次关闭。
 */
export type ExistingDocRevalidation<D> =
  | { readonly kind: "current"; readonly doc: D }
  | { readonly kind: "stale"; readonly closeGuard: FenceSnapshot };

/** 丢弃水合期间已被换代 / 关闭的本地 Doc；销毁失败只上报，不覆盖主流程结论。 */
export async function discardOpenedDoc(
  doc: ChatDoc | SessionDoc,
  context: string,
  onError: DocOpenFenceDeps["onError"],
): Promise<void> {
  try {
    await doc.destroy();
  } catch (err) {
    onError?.(context, err);
  }
}

/**
 * `stale` 水合失败的收口：map 已有新世代 Doc 时直接返回它；本地换代仍在途时等待后重查；
 * 否则返回 null，由调用方重新读取 active generation 并在上限内重试加载。
 */
export async function resolveStaleOpen<D>(
  fences: ProjectionFences,
  kind: ProjectionDocKind,
  rcsSessionId: string,
  snapshot: FenceSnapshot,
  docs: Map<string, D>,
): Promise<D | null> {
  for (;;) {
    const current = docs.get(rcsSessionId);
    if (current) return current;
    if (fences.isClosed(snapshot)) throw new Error(`${kind} doc was closed during open`);
    if (!fences.hasReplacement(rcsSessionId)) return null;
    await fences.waitForReplacement(rcsSessionId);
  }
}

/**
 * open 的关闭判定：除内部快照外还要看快路径复核起点的快照。close 可能落在旧 Doc
 * 从 map 删除之后、内部快照捕获之前，此时内部快照拿到的是新建 fence，看不到关闭。
 */
export function isClosedForOpen(
  fences: ProjectionFences,
  snapshot: FenceSnapshot,
  closeGuard?: FenceSnapshot,
): boolean {
  if (fences.isClosed(snapshot)) return true;
  return closeGuard !== undefined && fences.isClosed(closeGuard);
}

/**
 * 加载完成后的安装收口。与旧实现的区别是把“换代失败”从“关闭”中拆开：
 * - 关闭：丢弃并拒绝；
 * - 换代成功：返回 map 中的新世代 Doc；
 * - 换代失败：active generation 未变，复核世代后安装本次加载结果；
 * - 等待期间又出现换代：继续等待，绝不在换代未落定时写 map。
 */
export async function finalizeOpenedDoc<D extends ChatDoc | SessionDoc>(
  deps: DocOpenFenceDeps,
  kind: ProjectionDocKind,
  rcsSessionId: string,
  snapshot: FenceSnapshot,
  closeGuard: FenceSnapshot | undefined,
  docs: Map<string, D>,
  doc: D,
  redis: Redis | Cluster | null,
): Promise<{ kind: "current"; doc: D } | { kind: "installed" } | { kind: "retry" }> {
  const context = `[DocManager] destroy stale ${kind} doc for ${rcsSessionId}`;
  const maxSettleLoops = 8;
  let observedReplaceEpoch = snapshot.replaceEpoch;

  for (let loop = 0; loop < maxSettleLoops; loop += 1) {
    const current = docs.get(rcsSessionId);
    if (current) {
      await discardOpenedDoc(doc, context, deps.onError);
      return { kind: "current", doc: current };
    }
    if (isClosedForOpen(deps.fences, snapshot, closeGuard)) {
      await discardOpenedDoc(doc, context, deps.onError);
      throw new Error(`${kind} doc was closed during open`);
    }

    if (deps.fences.hasReplacement(rcsSessionId)) {
      await deps.fences.waitForReplacement(rcsSessionId);
      continue;
    }

    // Redis 模式下安装前始终复核 active generation：fence 只能观察本进程经过同一对象的
    // 换代，close 删除登记后新 open 拿到的是新 fence；跨进程换代也不会触碰本地 epoch。
    // 复核结果先暂存，等同步段确认 close/换代优先级后再决定安装还是重试。
    const generationCurrent = redis ? await isGenerationCurrent(redis, rcsSessionId, doc.generation) : true;

    // 复核 await 窗口内可能发生 close / replace 提交：以下检查到写 map 之间没有 await。
    const settledCurrent = docs.get(rcsSessionId);
    if (settledCurrent) {
      await discardOpenedDoc(doc, context, deps.onError);
      return { kind: "current", doc: settledCurrent };
    }
    if (isClosedForOpen(deps.fences, snapshot, closeGuard)) {
      await discardOpenedDoc(doc, context, deps.onError);
      throw new Error(`${kind} doc was closed during open`);
    }
    if (deps.fences.hasReplacement(rcsSessionId)) continue;
    if (snapshot.fence.replaceEpoch !== observedReplaceEpoch) {
      observedReplaceEpoch = snapshot.fence.replaceEpoch;
      continue;
    }
    if (!generationCurrent) {
      await discardOpenedDoc(doc, context, deps.onError);
      return { kind: "retry" };
    }

    // 从这里到写 map 没有 await：check-then-install 原子，close / replace 无法插队。
    deps.registerDocBroadcast(doc.ydoc, `${kind}:${rcsSessionId}`);
    docs.set(rcsSessionId, doc);
    return { kind: "installed" };
  }

  await discardOpenedDoc(doc, context, deps.onError);
  throw new Error(`projection replacement did not settle during ${kind} open for ${rcsSessionId}`);
}

/** Redis 模式下确认加载世代仍是 active generation；内存模式没有跨进程换代。 */
export async function isGenerationCurrent(
  redis: Redis | Cluster | null,
  rcsSessionId: string,
  generation: string,
): Promise<boolean> {
  if (!redis) return true;
  // 只读复核：不复用 getOrCreateActiveGeneration，避免 key 缺失时凭空创建新世代。
  return (await getActiveGeneration(redis, rcsSessionId)) === generation;
}

/**
 * Redis 模式下已驻留 Doc 的快路径复核：跨进程换代不会触碰本地 fence，只能以只读
 * active generation 判定。返回 `current` 表示可直接复用；返回 `stale` 表示已驻留 Doc
 * 过期，并携带复核起点的 fence 快照，供重载流程在安装前识别同一窗口内的 close。
 */
export async function revalidateExistingDoc<D extends ChatDoc | SessionDoc>(
  deps: DocOpenFenceDeps,
  kind: ProjectionDocKind,
  rcsSessionId: string,
  existing: D,
  docs: Map<string, D>,
): Promise<ExistingDocRevalidation<D>> {
  const redis = deps.getRedis();
  // 内存模式没有跨进程换代，保持原有直接返回语义。
  if (!redis) return { kind: "current", doc: existing };

  // 先捕获 fence 快照再 await：复核窗口内 close 必须让本次 open 放弃，不得复活。
  const snapshot = deps.fences.snapshot(kind, rcsSessionId);
  let active: string | null;
  try {
    active = await getActiveGeneration(redis, rcsSessionId);
  } catch (err) {
    // 已有 Doc 时 Redis 故障优先可用性：不重载、不销毁，避免调用方因 open 失败
    // 继续写消息而丢事件。代价是故障期间不收敛跨进程换代，恢复后下一次 open 收敛。
    deps.onError?.(
      `[DocManager] active generation revalidation failed for existing ${kind} doc ${rcsSessionId}; reusing in-memory doc`,
      err,
    );
    return { kind: "current", doc: existing };
  }

  if (deps.fences.isClosed(snapshot)) throw new Error(`${kind} doc was closed during open`);
  const current = docs.get(rcsSessionId);
  // 复核窗口内已被 close（map 为空）或 replace（map 已换对象）：以 map 当前值为准。
  if (current !== existing) {
    return current ? { kind: "current", doc: current } : { kind: "stale", closeGuard: snapshot };
  }
  if (active === existing.generation) return { kind: "current", doc: existing };
  return { kind: "stale", closeGuard: snapshot };
}

/**
 * open 返回前的同步复核：close 可能落在安装完成之后、调用方续体之前。
 * map 为空说明关闭已发生，拒绝返回已销毁 Doc；已被换代则返回 map 中的当前对象。
 */
export function requireCurrentDoc<D extends ChatDoc | SessionDoc>(
  kind: ProjectionDocKind,
  rcsSessionId: string,
  docs: Map<string, D>,
): D {
  const current = docs.get(rcsSessionId);
  if (current) return current;
  throw new Error(`${kind} doc was closed during open`);
}

export function isStaleHydration(error: unknown): error is SnapshotHydrationError {
  return error instanceof SnapshotHydrationError && error.outcome.status === "stale";
}
