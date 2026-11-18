import { expect, test } from "bun:test";
import { scopeKey } from "../sync/protocol/identity";
import { fixture, contentObjectInput as object } from "./sync-live-admission-fixture";

// 即使全部分片已命中，读取期间租约过期也不能由旧写者确认成功。
test("对象重试全命中但读取期间租约过期时拒绝成功", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("same"));
    f.faults.afterLocate = () => f.advance(31000);
    await expect(f.writer.accept(object("same"))).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    await f.writer.acquire();
    await f.writer.accept(object("after"));
    expect(await f.readAll()).toHaveLength(2);
  } finally {
    await f.close();
  }
});

// scope 指针在读取后换代时，旧代次的已提交对象不能代表新代次的写入结果。
test("对象重试全命中但读取期间换代时拒绝旧代成功", async () => {
  const f = await fixture();
  const key = scopeKey(f.scope);
  try {
    await f.writer.accept(object("same"));
    f.faults.afterLocate = async () => {
      const pointer = await f.store.readScopePointer(key);
      if (!pointer?.currentGeneration) throw new Error("Missing pointer");
      const old = await f.store.readGeneration(key, pointer.currentGeneration);
      if (!old) throw new Error("Missing generation");
      const next = { ...old, generation: "gen_next", state: "staging" as const };
      await f.store.createGeneration({ scopeKey: key, epoch: pointer.writerEpoch, generation: next });
      await f.store.commitGeneration({
        scopeKey: key,
        epoch: pointer.writerEpoch,
        newGeneration: next,
        expectedCurrent: old.generation,
        expectedPointerRevision: pointer.pointerRevision,
        entryClosure: next.entryRefs,
        retired: [old.generation],
      });
    };
    await expect(f.writer.accept(object("same"))).rejects.toMatchObject({ code: "GENERATION_MISMATCH" });
  } finally {
    await f.close();
  }
});

// 新写者接管后，旧写者即使命中全部正文，也不能跨 epoch 确认成功。
test("对象重试全命中但读取期间被新写者接管时拒绝成功", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("same"));
    f.faults.beforeConfirm = async (lease) => {
      await f.store.releaseWriter(lease);
      await f.store.acquireWriter(scopeKey(f.scope), "another-writer", 1000);
    };
    await expect(f.writer.accept(object("same"))).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
  } finally {
    await f.close();
  }
});

// 确认前租约到期仍须拒绝当前操作，但同一实例可以在之后重新接管。
test("对象重试在 Store 确认前租约过期后可重新接管", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("same"));
    f.faults.beforeConfirm = () => f.advance(31000);
    await expect(f.writer.accept(object("same"))).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  } finally {
    await f.close();
  }
});

// 后台续租完成后按当前 Store 状态确认，不使用旧快照中的到期时间误判。
test("全命中重试确认使用已经续租的当前租约", async () => {
  const f = await fixture();
  let renewed = false;
  try {
    await f.writer.accept(object("same"));
    f.faults.beforeConfirm = async (lease) => {
      f.advance(29999);
      await f.store.renewWriter(lease, 30000);
      f.advance(2);
      renewed = true;
    };
    await f.writer.accept(object("same"));
    expect(renewed).toBe(true);
    expect(await f.readAll()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

// 后台续租可先清理过期句柄，正在等待的重试失败后仍须允许同一 writer 重新接管。
test("后台续租清理过期租约后不会永久锁死正在重试的 writer", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("same"));
    f.faults.afterLocate = async () => {
      f.advance(31000);
      await expect(f.writer.renew()).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
    };
    await expect(f.writer.accept(object("same"))).rejects.toMatchObject({ code: "WRITER_EPOCH_LOST" });
    await f.writer.acquire();
    await f.writer.accept(object("after"));
    expect(await f.readAll()).toHaveLength(2);
  } finally {
    await f.close();
  }
});
