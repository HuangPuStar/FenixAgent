import { expect, test } from "bun:test";
import { createTextClaimLineage } from "../sync/live/text-claim-lineage";
import { textClaimHandoffFixture } from "./sync-live-text-claim-handoff-fixture";
import { gate, rejection, withinDeadline } from "./sync-live-writer-authority-fixture";

// 不同目标的 lineage 读取应独立恢复，前一个临时错误不能让后继检查直接继承拒绝。
test("前驱 lineage 读取失败后排队的 successor 仍检查真实链", async () => {
  const f = await textClaimHandoffFixture();
  const paused = gate();
  const failure = new Error("temporary route read failure");
  try {
    await f.append("A");
    await f.append("B");
    const snapshot = f.store.exportCommittedState();
    const key = snapshot.scopes[0]?.scopeKey;
    const tail = snapshot.docs.find((doc) => doc.kind === "content" && doc.state === "active")?.docId;
    if (!key || !tail || tail === f.contentId) throw new Error("Missing rotated live tail");
    let reads = 0;
    const store = new Proxy(f.store, {
      get(target, property) {
        if (property === "readSuccessor")
          return async (...args: Parameters<typeof f.store.readSuccessor>) => {
            if (reads++ === 0) {
              paused.enter();
              await paused.released;
              throw failure;
            }
            return target.readSuccessor(...args);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const lineage = createTextClaimLineage(store, key, f.admission);
    const first = rejection(lineage.read("gen_cursor", f.contentId));
    await withinDeadline(paused.entered);
    const second = lineage.read("gen_cursor", tail);
    const secondResult = second.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect(lineage.read("gen_cursor", tail)).toBe(second);
    paused.release();
    expect(await first).toBe(failure);
    expect(await secondResult).toEqual({ value: new Set([f.contentId, tail]) });
    expect(reads).toBe(3);
    lineage.clear();
  } finally {
    paused.release();
    await f.close();
  }
});

// clear 同时失效尚未执行的队列任务，避免关闭后旧任务重新占用缓存额度。
test("lineage clear 阻止排队旧读取重建缓存和占用额度", async () => {
  const f = await textClaimHandoffFixture();
  const paused = gate();
  try {
    await f.append("A");
    await f.append("B");
    const state = f.store.exportCommittedState();
    const key = state.scopes[0]?.scopeKey;
    const tail = state.docs.find((doc) => doc.kind === "content" && doc.state === "active")?.docId;
    if (!key || !tail) throw new Error("Missing committed tail");
    let reads = 0;
    const store = new Proxy(f.store, {
      get(target, property) {
        if (property === "readSuccessor")
          return async (...args: Parameters<typeof f.store.readSuccessor>) => {
            if (reads++ === 0) {
              paused.enter();
              await paused.released;
            }
            return target.readSuccessor(...args);
          };
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const lineage = createTextClaimLineage(store, key, f.admission);
    const before = f.admission.used("controlIndex");
    const first = rejection(lineage.read("gen_cursor", f.contentId));
    await withinDeadline(paused.entered);
    const second = rejection(lineage.read("gen_cursor", tail));
    lineage.clear();
    paused.release();
    expect(await first).toMatchObject({ code: "GENERATION_MISMATCH" });
    expect(await second).toMatchObject({ code: "GENERATION_MISMATCH" });
    expect(reads).toBe(1);
    expect(f.admission.used("controlIndex")).toBe(before);
    lineage.clear();
  } finally {
    paused.release();
    await f.close();
  }
});
