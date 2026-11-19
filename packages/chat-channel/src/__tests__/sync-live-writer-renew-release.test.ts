import { expect, test } from "bun:test";
import { LIVE_WRITER_LEASE_TTL_MS } from "../sync/live/live-writer";
import { WriterAuthority } from "../sync/live/writer-authority";
import { scopeKey } from "../sync/protocol/identity";
import { authorityFixture, gate, rejection, text, withinDeadline } from "./sync-live-writer-authority-fixture";

// 普通续租故障仍须关闭输入，但 close 必须释放 Store 中尚未过期的真实租约。
test("续租非租约错误后关闭释放真实租约且不重新开放输入", async () => {
  const f = await authorityFixture();
  const key = scopeKey(f.scope);
  const renew = f.store.renewWriter.bind(f.store);
  const unavailable = new Error("renew unavailable");
  f.store.renewWriter = () => Promise.reject(unavailable);
  try {
    expect(await rejection(f.writer.renew())).toBe(unavailable);
    await expect(f.writer.accept(text("blocked"))).rejects.toHaveProperty("code", "WRITER_EPOCH_LOST");
    await expect(f.store.acquireWriter(key, "replacement", LIVE_WRITER_LEASE_TTL_MS)).rejects.toHaveProperty(
      "code",
      "SCOPE_BUSY",
    );
    await f.writer.close();
    const lease = await f.store.acquireWriter(key, "replacement", LIVE_WRITER_LEASE_TTL_MS);
    expect(lease.owner).toBe("replacement");
    await f.store.releaseWriter(lease);
    expect(await f.readAll()).toEqual([]);
  } finally {
    f.store.renewWriter = renew;
    await f.close();
  }
});

// 释放失败必须把原续租错误保留为诊断上下文，不能以新的释放错误覆盖失权根因。
test("续租失败后的关闭释放错误保留原始续租诊断", async () => {
  const f = await authorityFixture();
  const renew = f.store.renewWriter.bind(f.store);
  const release = f.store.releaseWriter.bind(f.store);
  const original = new Error("renew unavailable");
  const cleanup = new Error("release unavailable");
  f.store.renewWriter = () => Promise.reject(original);
  let releases = 0;
  f.store.releaseWriter = () => {
    releases++;
    return Promise.reject(cleanup);
  };
  try {
    expect(await rejection(f.writer.renew())).toBe(original);
    const result = await rejection(f.writer.close());
    expect(result).toBe(original);
    expect(original.cause).toBeInstanceOf(AggregateError);
    expect((original.cause as AggregateError).errors).toContain(cleanup);
    expect(releases).toBe(1);
    await f.writer.close();
    expect(releases).toBe(1);
  } finally {
    f.store.renewWriter = renew;
    f.store.releaseWriter = release;
    await f.close();
  }
});

// 过期旧 owner 的释放令牌只能释放旧 epoch，不能影响已经接管成功的另一 owner。
test("续租失败后旧 owner 关闭不释放替换 owner 租约", async () => {
  const f = await authorityFixture();
  const renew = f.store.renewWriter.bind(f.store);
  const original = new Error("renew unavailable");
  f.store.renewWriter = () => Promise.reject(original);
  try {
    expect(await rejection(f.writer.renew())).toBe(original);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    const lease = await f.store.acquireWriter(scopeKey(f.scope), "replacement", LIVE_WRITER_LEASE_TTL_MS);
    await f.writer.close();
    expect(await f.store.readScopePointer(scopeKey(f.scope))).toMatchObject({
      writerOwner: lease.owner,
      writerEpoch: lease.epoch,
      leaseExpiresAt: lease.expiresAt,
    });
    await f.store.releaseWriter(lease);
  } finally {
    f.store.renewWriter = renew;
    await f.close();
  }
});

// 迟到的旧续租失败不能清掉新 take 的门禁或改写 close 最终释放的真实令牌。
test("旧 renew 回执失败不能覆盖新 token 的可用和释放租约", async () => {
  const f = await authorityFixture();
  await f.writer.close();
  const key = scopeKey(f.scope);
  const paused = gate();
  const original = new Error("old renew unavailable");
  const renew = f.store.renewWriter.bind(f.store);
  const releases: number[] = [];
  const release = f.store.releaseWriter.bind(f.store);
  const authority = new WriterAuthority(
    f.store,
    () => null,
    () => {},
  );
  f.store.renewWriter = async () => {
    paused.enter();
    await paused.released;
    throw original;
  };
  f.store.releaseWriter = async (lease) => {
    releases.push(lease.epoch);
    await release(lease);
  };
  let pending: Promise<unknown> | undefined;
  try {
    const old = await f.store.acquireWriter(key, "same-owner", LIVE_WRITER_LEASE_TTL_MS);
    const token = authority.take(old);
    authority.install(token, "gen_cursor");
    pending = rejection(authority.renew(token));
    await withinDeadline(paused.entered);
    f.advance(LIVE_WRITER_LEASE_TTL_MS + 1);
    const current = await f.store.acquireWriter(key, "same-owner", LIVE_WRITER_LEASE_TTL_MS);
    const replacement = authority.take(current);
    authority.install(replacement, "gen_cursor");
    paused.release();
    expect(await pending).toBe(original);
    expect(authority.capture()).toBe(replacement);
    await authority.close();
    expect(releases).toEqual([current.epoch]);
    expect((await f.store.readScopePointer(key))!.writerOwner).toBeNull();
  } finally {
    paused.release();
    if (pending) await pending;
    await authority.close();
    f.store.renewWriter = renew;
    f.store.releaseWriter = release;
    await f.close();
  }
});
