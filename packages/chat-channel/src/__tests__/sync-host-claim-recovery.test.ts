import { expect, test } from "bun:test";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { createSyncHostSession } from "../sync/runtime/host-session";
import { authorityFixture, gate, replaceGeneration, withinDeadline } from "./sync-live-writer-authority-fixture";

/** fire-and-forget host 入口以实际提交或停止状态作为完成信号。 */
async function waitUntil(predicate: () => Promise<boolean> | boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("host ingress did not settle");
}

for (const changedGeneration of [false, true]) {
  // 未进入 merge 的同代次声明失效可重判一次；换代则不得把原消息复活到新代次。
  test(`在途用户声明跨过接管后保持宿主接收边界，换代=${changedGeneration}`, async () => {
    const f = await authorityFixture();
    await f.writer.close();
    const paused = gate();
    const rebuilt = gate();
    const locate = f.store.locateRefs.bind(f.store);
    let pause = true;
    f.store.locateRefs = async (query) => {
      const result = await locate(query);
      if (pause && query.lookupKind === "live-text") {
        pause = false;
        paused.enter();
        await paused.released;
      }
      return result;
    };
    const acquire = f.store.acquireWriter.bind(f.store);
    let acquisitions = 0;
    let secondEpoch = -1;
    f.store.acquireWriter = async (...args) => {
      const lease = await acquire(...args);
      if (++acquisitions === 2) {
        if (changedGeneration) await replaceGeneration(f, lease);
        secondEpoch = lease.epoch;
      }
      return lease;
    };
    const confirm = f.store.confirmWriter.bind(f.store);
    f.store.confirmWriter = async (lease, generation) => {
      await confirm(lease, generation);
      if (lease.epoch === secondEpoch) rebuilt.enter();
    };
    const errors: unknown[] = [];
    const host = await createSyncHostSession({
      scope: f.scope,
      store: f.store,
      clock: f.clock,
      digest: sha256Digest,
      random: deterministicRandomSource("host-claim-recovery"),
      runtimeConfig: { sealGraceMs: 100, retireGraceMs: 100, tickIntervalMs: 600000 },
      overrides: { merge: { maxBytes: 1, maxDelayMs: 600000 } },
      transport: { send: () => true, bufferedAmount: () => 0, close: () => {} },
      onError: (_message, error) => errors.push(error),
    });
    try {
      host.acceptUserMessage("first", "first");
      await withinDeadline(paused.entered);
      f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      await host.tick();
      host.acceptNormalizedEvent({
        type: "message_delta",
        turnId: "second",
        update: {},
        content: { type: "text", text: "second" },
      });
      await withinDeadline(rebuilt.entered);
      // 让接管的同步安装与入口排队完成后，再交付旧 claim 的只读结果。
      await new Promise((resolve) => setTimeout(resolve, 0));
      paused.release();
      if (changedGeneration) {
        await waitUntil(() => host.ingressDiagnostics().stopped);
        expect(host.ingressDiagnostics()).toMatchObject({ total: 1, lastCode: "GENERATION_MISMATCH", stopped: true });
        expect((await f.readAll()).some((record) => new TextDecoder().decode(record.payload) === "first")).toBe(false);
      } else {
        await waitUntil(async () => host.ingressDiagnostics().stopped || (await f.readAll()).length === 2);
        expect(host.ingressDiagnostics().stopped).toBe(false);
        host.acceptUserMessage("third", "third");
        await waitUntil(async () => (await f.readAll()).length === 3);
        expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
          "first",
          "second",
          "third",
        ]);
        expect(host.ingressDiagnostics()).toMatchObject({ total: 0, lastCode: null, stopped: false });
        expect(errors).toEqual([]);
      }
    } finally {
      paused.release();
      await host.dispose();
      await f.close();
    }
  });
}
