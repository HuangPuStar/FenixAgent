import { expect, test } from "bun:test";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY } from "../sync/capacity/profile";
import { textInputReservations } from "../sync/capacity/text-plan-reservations";
import type { MergeFlushRequest, MergeKey } from "../sync/live/merge-buffer";
import { WriterTextBarrier } from "../sync/live/writer-text-barrier";
import { assertIdentifier, MAX_IDENTIFIER_BYTES } from "../sync/protocol/identity";
import { gate, withinDeadline } from "./sync-live-writer-authority-fixture";

// 五段身份都达到合法上限时，首字节仍可在精确队列额度内保留；同键重发共享原 attempt 不重复计费。
test("最长合法 MergeKey 在精确保留额度内首写并共享在途结果", async () => {
  const identity = "i".repeat(MAX_IDENTIFIER_BYTES);
  const key: MergeKey = {
    generation: identity,
    turnId: identity,
    entryId: identity,
    contentSlot: identity,
    contentType: identity,
  };
  for (const [field, value] of Object.entries(key)) assertIdentifier(value, field);
  const minimum = textInputReservations(MAX_IDENTIFIER_BYTES * 5, 1);
  const admission = new AdmissionController({
    ...DEFAULT_SYNC_CAPACITY,
    serverPools: { ...DEFAULT_SYNC_CAPACITY.serverPools, ...minimum },
  });
  const token = {
    generation: identity,
    lease: { scopeKey: "org/session", epoch: 1, owner: "writer", expiresAt: 1000 },
  };
  const paused = gate();
  const writes: MergeFlushRequest[] = [];
  const failures: unknown[] = [];
  const barrier = new WriterTextBarrier({
    admission,
    clock: { now: () => 1 },
    merge: { maxDelayMs: 600000, maxBytes: 1 },
    capture: () => token,
    enqueue: (task) => Promise.resolve().then(task),
    write: async (request) => {
      paused.enter();
      await paused.released;
      writes.push(request);
    },
    isCurrent: (value) => value === token,
    shouldReplay: async () => true,
    onFailure: (error) => failures.push(error),
  });
  try {
    const pending = barrier.push(key, "x", true);
    await withinDeadline(paused.entered);
    expect(admission.used("controlIndex")).toBe(minimum.controlIndex);
    expect(admission.used("ingressSpool")).toBe(minimum.ingressSpool);
    expect(barrier.pending(identity, identity, identity)).toBe(pending);
    expect(admission.used("controlIndex")).toBe(minimum.controlIndex);
    paused.release();
    await pending;
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ key, text: "x", bytes: 1 });
    expect(barrier.pending(identity, identity, identity)).toBeNull();
    expect(failures).toEqual([]);
  } finally {
    paused.release();
    await barrier.flush();
    barrier.close();
  }
  expect(admission.used("controlIndex")).toBe(0);
  expect(admission.used("ingressSpool")).toBe(0);
});
