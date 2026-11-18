import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { createLiveWriter } from "../sync/live/live-writer";
import { RUNTIME_DOC_LIMITS } from "../sync/live/runtime-doc";
import { parseDocId } from "../sync/protocol/identity";
import type { AppendUpdatesInput, RegisterSuccessorInput, RegistrationResult } from "../sync/store/types";
import { fixture } from "./sync-live-admission-fixture";

/** 保留真实路由、租约和目录事务，只在事务边界控制时钟或回执。 */
export async function writerFailureFixture(
  options: { readonly capacity?: SyncCapacityProfile; readonly maxDelayMs?: number } = {},
) {
  const base = await fixture();
  await base.writer.close();
  let now = 1000;
  const clock = { now: () => now };
  const faults = {
    beforeRoute: null as
      | ((input: RegisterSuccessorInput) => Promise<RegistrationResult | undefined> | RegistrationResult | undefined)
      | null,
    afterRoute: null as (() => void) | null,
    beforeDirectoryAppend: null as (() => void) | null,
    failRouteRead: false,
  };
  const readError = new Error("route boundary unavailable");
  const wrapped = new Proxy(base.store, {
    get(target, property) {
      if (property === "registerSuccessor")
        return async (input: RegisterSuccessorInput) => {
          const before = faults.beforeRoute;
          faults.beforeRoute = null;
          const replacement = await before?.(input);
          if (replacement) return replacement;
          const result = await target.registerSuccessor(input);
          const after = faults.afterRoute;
          faults.afterRoute = null;
          after?.();
          return result;
        };
      if (property === "readSuccessor")
        return (...args: Parameters<typeof target.readSuccessor>) =>
          faults.failRouteRead ? Promise.reject(readError) : target.readSuccessor(...args);
      if (property === "appendUpdates")
        return async (input: AppendUpdatesInput) => {
          if (input.updates.some((update) => parseDocId(update.docId).kind === "directory")) {
            const before = faults.beforeDirectoryAppend;
            faults.beforeDirectoryAppend = null;
            before?.();
          }
          return await target.appendUpdates(input);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const writer = createLiveWriter({
    scope: base.scope,
    store: wrapped,
    clock,
    digest: sha256Digest,
    random: deterministicRandomSource("failure-writer"),
    capacity: options.capacity ?? DEFAULT_SYNC_CAPACITY,
    admission: base.admission,
    merge: { maxDelayMs: options.maxDelayMs ?? 600000, maxBytes: 1 << 20 },
    limits: RUNTIME_DOC_LIMITS,
    rotation: {
      clock,
      random: deterministicRandomSource("failure-rotation"),
      limits: RUNTIME_DOC_LIMITS,
      maxResidentMs: 600000,
      maxTransactions: 1000,
    },
  });
  await writer.acquire();
  return {
    ...base,
    writer,
    faults,
    readError,
    advance(ms: number) {
      now += ms;
      base.advance(ms);
    },
    async close() {
      await writer.close();
      await base.close();
    },
  };
}
