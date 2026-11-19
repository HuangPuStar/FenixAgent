import { expect, test } from "bun:test";
import * as Y from "yjs";
import { sha256Digest } from "../sync/clock";
import { LIVE_WRITER_LEASE_TTL_MS, type LiveInput } from "../sync/live/live-writer";
import { buildDocId, scopeKey } from "../sync/protocol/identity";
import type { WriterLease } from "../sync/store/types";
import { contentObjectInput as object } from "./sync-live-admission-fixture";
import { writerFailureFixture } from "./sync-live-writer-failure-fixture";

/** 控制真实事务的暂停点；超时只约束等待进入，finally 始终释放事务。 */
function gate() {
  let enter: () => void = () => {};
  let release: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { entered, released, enter, release };
}

/** 让事务入口丢失时先退出测试并执行清理，不依赖测试运行器的超时。 */
async function withinDeadline<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("writer transaction did not reach its gate")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** 异键输入会逐次冲刷旧缓冲，从公共入口排出多个真实写任务。 */
function text(entryId: string): LiveInput {
  return {
    kind: "text-delta",
    turnId: "turn",
    entryId,
    contentSlot: "text",
    contentType: "text/plain",
    delta: entryId,
  };
}

/** 立即登记拒绝处理，避免事务暂停期间的后台拒绝变成未处理异常。 */
function rejection(pending: Promise<unknown>): Promise<unknown> {
  return pending.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** 最后一个对象屏障也只等待文本；租约丢失后它本身不得进入存储。 */
async function queueTexts(f: Awaited<ReturnType<typeof writerFailureFixture>>) {
  await f.writer.accept(text("queued-a"));
  return [
    rejection(f.writer.accept(text("queued-b"))),
    rejection(f.writer.accept(text("queued-c"))),
    rejection(f.writer.accept(object("barrier"))),
  ];
}

/** 缓冲接纳已成功的输入不借用前驱回执，最后的显式屏障仍必须保留同一个真实失败。 */
async function expectBufferedThenBarrier(pending: readonly Promise<unknown>[], failure: unknown) {
  const results = await Promise.all(pending);
  expect(results.slice(0, -1).every((result) => result === undefined)).toBe(true);
  expect(results.at(-1)).toBe(failure);
}

/** 以新租约提交独立的空代次，验证接管不能把旧任务写进新的权威入口。 */
async function replaceGeneration(f: Awaited<ReturnType<typeof writerFailureFixture>>, lease: WriterLease) {
  const key = scopeKey(f.scope);
  const pointer = await f.store.readScopePointer(key);
  if (!pointer?.currentGeneration) throw new Error("missing scope generation");
  const old = await f.store.readGeneration(key, pointer.currentGeneration);
  if (!old) throw new Error("missing current generation");
  const generation = "gen_reacquired";
  const id = (kind: "control" | "directory" | "runtime" | "content") =>
    buildDocId({ kind, generation, blockIndex: 0, nonce: kind });
  const next = {
    ...old,
    generation,
    state: "staging" as const,
    entryRefs: {
      controlDocId: id("control"),
      directoryDocId: id("directory"),
      runtimeDocId: id("runtime"),
      contentDocIds: [id("content")],
    },
  };
  await f.store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: next });
  const doc = new Y.Doc();
  const snapshot = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  for (const kind of ["runtime", "content"] as const)
    await f.store.createDoc({
      scopeKey: key,
      epoch: lease.epoch,
      doc: {
        scopeKey: key,
        generation,
        docId: id(kind),
        kind,
        state: "active",
        snapshot,
        hash: sha256Digest(snapshot),
        baseSeq: 0,
        finalSeq: null,
        blockIndex: 0,
        ordinalStart: null,
        ordinalEnd: null,
        dependsOn: [],
      },
    });
  await f.store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    newGeneration: next,
    expectedCurrent: old.generation,
    expectedPointerRevision: pointer.pointerRevision,
    entryClosure: next.entryRefs,
    retired: [old.generation],
  });
}

for (const changedGeneration of [false, true]) {
  // 旧回执先按原错结清；同代接管显式重放完整保留队列，真正换代才退休旧文本。
  test(`200 个保留窗口过期后由屏障拒绝并按代次恢复，换代=${changedGeneration}`, async () => {
    const f = await writerFailureFixture();
    const route = gate();
    let appendsAfterExpiry = 0;
    try {
      await f.writer.accept(object("before"));
      f.faults.beforeRoute = async () => {
        route.enter();
        await route.released;
        f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
        const append = f.store.appendUpdates.bind(f.store);
        f.store.appendUpdates = (input) => {
          appendsAfterExpiry++;
          return append(input);
        };
        return;
      };
      const sealing = rejection(f.writer.seal());
      await withinDeadline(route.entered);
      await f.writer.accept(text("queued-0"));
      const pending: Promise<unknown>[] = [];
      for (let index = 1; index < 200; index++) pending.push(rejection(f.writer.accept(text(`queued-${index}`))));
      pending.push(rejection(f.writer.accept(object("barrier"))));
      if (changedGeneration) {
        const acquire = f.store.acquireWriter.bind(f.store);
        f.store.acquireWriter = async (...args) => {
          const lease = await acquire(...args);
          await replaceGeneration(f, lease);
          return lease;
        };
      }
      route.release();
      const failure = await sealing;
      expect(failure).toMatchObject({ code: "LEASE_EXPIRED" });
      await f.writer.acquire();
      expect(pending).toHaveLength(200);
      await expectBufferedThenBarrier(pending, failure);
      expect(appendsAfterExpiry).toBe(0);
      expect(await f.store.readScopePointer(scopeKey(f.scope))).toMatchObject({
        currentGeneration: changedGeneration ? "gen_reacquired" : "gen_cursor",
      });
      await f.writer.accept(object("after"));
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
        '{"value":"before"}',
        ...(!changedGeneration ? Array.from({ length: 200 }, (_, index) => `queued-${index}`) : []),
        '{"value":"after"}',
      ]);
      expect(appendsAfterExpiry).toBe(1);
    } finally {
      route.release();
      await f.close();
    }
  });
}

// 等待旧队列期间发生关闭，接管必须复核生命周期，不能在关闭后取得新租约。
test("可恢复接管等待旧队列时关闭会拒绝接管", async () => {
  const f = await writerFailureFixture();
  const route = gate();
  try {
    f.faults.beforeRoute = async () => {
      route.enter();
      await route.released;
      f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      return;
    };
    const sealing = rejection(f.writer.seal());
    await withinDeadline(route.entered);
    const queued = await queueTexts(f);
    route.release();
    const failure = await sealing;
    expect(failure).toMatchObject({ code: "LEASE_EXPIRED" });
    const acquired = rejection(f.writer.acquire());
    expect(await rejection(f.writer.close())).toBe(failure);
    expect(await acquired).toMatchObject({ code: "RESOURCE_RETIRED" });
    await expectBufferedThenBarrier(queued, failure);
    expect(await f.readAll()).toEqual([]);
  } finally {
    route.release();
    await f.close();
  }
});

for (const action of ["seal", "rotateRuntime"] as const) {
  // 未发布路由的过期必须先关住队列，所有冲刷均暴露同一个原错，重建后恢复真实写入。
  test(`${action} 路由前过期阻止多个排队冲刷并允许原 writer 接管`, async () => {
    const f = await writerFailureFixture();
    const route = gate();
    let expired = false;
    let appendsAfterExpiry = 0;
    const append = f.store.appendUpdates.bind(f.store);
    f.store.appendUpdates = (input) => {
      if (expired) appendsAfterExpiry++;
      return append(input);
    };
    try {
      await f.writer.accept(object("before"));
      f.faults.beforeRoute = async () => {
        route.enter();
        await route.released;
        f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
        expired = true;
        return;
      };
      const sealing = rejection(f.writer[action]());
      await withinDeadline(route.entered);
      const queued = await queueTexts(f);
      route.release();
      const failure = await sealing;
      expect(failure).toMatchObject({ code: "LEASE_EXPIRED" });
      await expectBufferedThenBarrier(queued, failure);
      await expect(f.writer.accept(object("observe"))).rejects.toBe(failure);
      expect(appendsAfterExpiry).toBe(0);
      expect(await f.readAll()).toHaveLength(1);
      const docId = action === "seal" ? f.contentId : f.runtimeId;
      expect(await f.store.readSuccessor(scopeKey(f.scope), docId)).toMatchObject({ state: "active", route: null });
      await f.writer.acquire();
      await f.writer.accept(object("after"));
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
        '{"value":"before"}',
        "queued-a",
        "queued-b",
        "queued-c",
        '{"value":"after"}',
      ]);
      expect(appendsAfterExpiry).toBe(1);
    } finally {
      route.release();
      await f.close();
    }
  });
}

// 竞争失败与未完成的权威重建都不能清掉过期门禁，只有重建成功才开放输入。
test("排队冲刷过期在 SCOPE_BUSY 和重建期间保持原错", async () => {
  const f = await writerFailureFixture();
  const route = gate();
  const rebuilding = gate();
  try {
    f.faults.beforeRoute = async () => {
      route.enter();
      await route.released;
      f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      return;
    };
    const sealing = rejection(f.writer.seal());
    await withinDeadline(route.entered);
    const queued = await queueTexts(f);
    route.release();
    const failure = await sealing;
    expect(failure).toMatchObject({ code: "LEASE_EXPIRED" });
    await expectBufferedThenBarrier(queued, failure);
    const other = await f.store.acquireWriter(scopeKey(f.scope), "other-writer", 1000);
    try {
      await expect(f.writer.acquire()).rejects.toMatchObject({ code: "SCOPE_BUSY" });
      await expect(f.writer.accept(object("busy"))).rejects.toBe(failure);
    } finally {
      await f.store.releaseWriter(other);
    }
    const readPointer = f.store.readScopePointer.bind(f.store);
    f.store.readScopePointer = async (key) => {
      rebuilding.enter();
      await rebuilding.released;
      return readPointer(key);
    };
    const acquired = f.writer.acquire();
    await withinDeadline(
      Promise.race([
        rebuilding.entered,
        acquired.then(() => {
          throw new Error("acquisition completed before rebuild gate");
        }),
      ]),
    );
    await expect(f.writer.accept(object("rebuilding"))).rejects.toBe(failure);
    rebuilding.release();
    await acquired;
    await f.writer.accept(object("after"));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual([
      "queued-a",
      "queued-b",
      "queued-c",
      '{"value":"after"}',
    ]);
  } finally {
    route.release();
    rebuilding.release();
    await f.close();
  }
});

// 对象追加回执晚于游标恢复失败，不能用原始拒绝值覆盖已形成的停写诊断。
test("对象追加拒绝保留已有停写错误及恢复诊断", async () => {
  const f = await writerFailureFixture();
  const appendError = { reason: "append unavailable" };
  const reloadError = new Error("cursor reload unavailable");
  try {
    f.store.appendUpdates = () => Promise.reject(appendError);
    f.store.readDocStateAt = () => Promise.reject(reloadError);
    expect(await rejection(f.writer.accept(object("barrier")))).toBe(appendError);
    const failure = await rejection(f.writer.accept(object("observe")));
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("missing retained recovery diagnostics");
    expect(failure.errors).toEqual([appendError, reloadError]);
    await expect(f.writer.acquire()).rejects.toBe(failure);
  } finally {
    await f.close();
  }
});

for (const phase of ["route", "directory", "unknown"] as const) {
  // 已发布或结果不明的路由仍然终止写入，排队文本不得把该终态变成可接管的过期。
  test(`多个排队冲刷在 ${phase} 失败后保持原错且禁止接管`, async () => {
    const f = await writerFailureFixture();
    const route = gate();
    try {
      f.faults.beforeRoute = async () => {
        route.enter();
        await route.released;
        if (phase === "unknown") {
          f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
          return { outcome: "unknown" };
        }
        return;
      };
      const expire = () => f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
      if (phase === "route") f.faults.afterRoute = expire;
      if (phase === "directory") f.faults.beforeDirectoryAppend = expire;
      const sealing = rejection(f.writer.seal());
      await withinDeadline(route.entered);
      const queued = await queueTexts(f);
      route.release();
      const failure = await sealing;
      expect(failure).toMatchObject({ code: phase === "unknown" ? "COMMIT_OUTCOME_UNKNOWN" : "LEASE_EXPIRED" });
      await expectBufferedThenBarrier(queued, failure);
      await expect(f.writer.acquire()).rejects.toBe(failure);
      await expect(f.writer.accept(object("blocked"))).rejects.toBe(failure);
      expect(await f.readAll()).toEqual([]);
      expect(await rejection(f.writer.close())).toBe(failure);
      expect(f.admission.used("ingressSpool")).toBe(0);
    } finally {
      route.release();
      await f.close();
    }
  });
}

// 文本使用离线游标，明确事务拒绝不触发无意义重载，正文全无并保留首错供后续输入观测。
test("文本整批拒绝不发布正文且保留原始停写错误", async () => {
  const f = await writerFailureFixture();
  const failure = { reason: "text batch unavailable" };
  try {
    f.faults.beforeTextBatch = () => {
      throw failure;
    };
    await f.writer.accept(text("queued"));
    expect(await rejection(f.writer.accept(object("barrier")))).toBe(failure);
    expect(await f.readAll()).toEqual([]);
    await expect(f.writer.acquire()).rejects.toBe(failure);
    await expect(f.writer.accept(object("observe"))).rejects.toBe(failure);
    expect(await rejection(f.writer.close())).toBe(failure);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await f.close();
  }
});
