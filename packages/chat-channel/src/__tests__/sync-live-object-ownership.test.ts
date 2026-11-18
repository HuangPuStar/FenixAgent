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
    f.faults.afterLocate = async () => {
      f.advance(31000);
      await f.store.acquireWriter(scopeKey(f.scope), "another-writer", 1000);
    };
    await expect(f.writer.accept(object("same"))).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  } finally {
    await f.close();
  }
});

// 最终指针读取也可能耗尽租约，必须以返回时的时钟复核读取到的租约期限。
test("对象重试在最终指针读取期间租约过期时拒绝成功", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("same"));
    f.faults.afterPointer = () => f.advance(31000);
    await expect(f.writer.accept(object("same"))).rejects.toMatchObject({ code: "LEASE_EXPIRED" });
  } finally {
    await f.close();
  }
});
