import type { MemoryContentBatchState } from "./memory-live-content-batch";
import { compositeKey, fail, type StoredDoc, type StoredGeneration } from "./memory-store-state";
import type { SyncRefRecord } from "./types";

/** 原子正文同时观察变更前后的身份，不确定证明保持未知而非永久否定。 */
export interface TextIdentityObservation {
  readonly before: ReadonlySet<string> | null;
  readonly after: ReadonlySet<string> | null;
  readonly destructiveBefore?: ReadonlySet<string> | null;
}

/** 已计费的代次元数据提供 O(1) 失效，块证明只在同版本内复用。 */
export function coverageRevision(generation: StoredGeneration | undefined): number {
  return generation?.textCoverageRevision ?? 0;
}

/** 一批变更中每代次只递增一次，准备与原子发布共用原 generation 前像。 */
export function changedCoverageGenerations(
  state: MemoryContentBatchState,
  identities: readonly { scopeKey: string; generation: string }[],
) {
  const result = new Map<string, { key: string; before: StoredGeneration; next: StoredGeneration }>();
  for (const identity of identities) {
    const key = compositeKey(identity.scopeKey, identity.generation);
    if (result.has(key)) continue;
    const before = state.generations.get(key);
    if (!before) fail("DOC_NOT_FOUND", "text coverage generation is unknown");
    const revision = coverageRevision(before);
    if (revision >= Number.MAX_SAFE_INTEGER) fail("CAPACITY_EXCEEDED", "text coverage revision exhausted");
    result.set(key, { key, before, next: { ...before, textCoverageRevision: revision + 1 } });
  }
  return [...result.values()];
}

/** 破坏性变更只有重新定位全部旧身份才保留跨块证明；正常追加不撤回旧块版本。 */
export function prepareContentCoverage(
  state: MemoryContentBatchState,
  identity: { scopeKey: string; generation: string },
  finalDocs: Map<string, StoredDoc>,
  observations: ReadonlyMap<string, TextIdentityObservation>,
  refs: readonly SyncRefRecord[],
  revision: number,
) {
  const indexed = new Set(refs.filter((ref) => ref.lookupKind === "live-text").map((ref) => ref.lookupId));
  const invalidates = [...observations.values()].some(
    (item) =>
      item.destructiveBefore !== undefined &&
      (item.destructiveBefore === null || [...item.destructiveBefore].some((key) => !indexed.has(key))),
  );
  const generations = changedCoverageGenerations(state, invalidates ? [identity] : []);
  for (const [id, item] of observations) {
    const proven =
      item.after !== null &&
      [...item.after].every((key) => indexed.has(key) || (!invalidates && item.before?.has(key)));
    finalDocs.set(id, {
      ...finalDocs.get(id)!,
      textCoverage: proven ? true : undefined,
      textCoverageRevision: invalidates ? revision + 1 : revision,
    });
  }
  return generations;
}
