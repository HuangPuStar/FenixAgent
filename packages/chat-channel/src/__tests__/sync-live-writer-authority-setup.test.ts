import { expect, test } from "bun:test";
import { scopeKey } from "../sync/protocol/identity";
import { authorityFixture, replaceGeneration } from "./sync-live-writer-authority-fixture";

// fixture 若忽略 staging 冲突，会在错误代次继续登记文档并污染后续权限测试的前提。
test("换代夹具在 staging 登记冲突时立即失败", async () => {
  const f = await authorityFixture();
  await f.writer.close();
  const lease = await f.store.acquireWriter(scopeKey(f.scope), "replacement-setup", 1000);
  try {
    const before = f.store.exportCommittedState();
    f.store.createGeneration = async () => ({ outcome: "conflict" });
    await expect(replaceGeneration(f, lease)).rejects.toThrow(/generation.*conflict/);
    expect(f.store.exportCommittedState()).toEqual(before);
  } finally {
    await f.store.releaseWriter(lease);
    await f.close();
  }
});

// 已有不同初始字节的 doc 不能被夹具当作空投影，冲突时指针必须留在旧代次。
test("换代夹具拒绝 replacement 文档登记冲突", async () => {
  const f = await authorityFixture();
  await f.writer.close();
  const key = scopeKey(f.scope);
  const lease = await f.store.acquireWriter(key, "replacement-setup", 1000);
  try {
    const before = await f.store.readScopePointer(key);
    f.store.createDoc = async () => ({ outcome: "conflict" });
    await expect(replaceGeneration(f, lease)).rejects.toThrow(/document.*conflict/);
    expect(await f.store.readScopePointer(key)).toEqual(before);
  } finally {
    await f.store.releaseWriter(lease);
    await f.close();
  }
});

// 指针 CAS 冲突不能伪装换代成功，错误需携带实际 generation 与 revision 以定位 setup 前提。
test("换代夹具拒绝未切换 current pointer 的提交回执", async () => {
  const f = await authorityFixture();
  await f.writer.close();
  const key = scopeKey(f.scope);
  const lease = await f.store.acquireWriter(key, "replacement-setup", 1000);
  try {
    const before = await f.store.readScopePointer(key);
    f.store.commitGeneration = async () => ({
      outcome: "conflict",
      currentGeneration: "gen_cursor",
      pointerRevision: 1,
    });
    await expect(replaceGeneration(f, lease)).rejects.toThrow(/gen_cursor.*revision 1/);
    expect(await f.store.readScopePointer(key)).toEqual(before);
  } finally {
    await f.store.releaseWriter(lease);
    await f.close();
  }
});
