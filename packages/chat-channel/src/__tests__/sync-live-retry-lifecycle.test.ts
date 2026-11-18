import { expect, test } from "bun:test";
import { fixture, contentObjectInput as object } from "./sync-live-admission-fixture";

// 探测时尚未落地不等于请求已结束，重试异常后不得在旧批次结果不明时接受新工作。
test("未知批次探测为空后重试异常停写并保留迟到提交", async () => {
  const f = await fixture();
  try {
    f.faults.unknownAppendOnce = true;
    f.faults.throwOnAppend = f.faults.appendCalls + 2;
    await expect(f.writer.accept(object("pending"))).rejects.toMatchObject({
      code: "COMMIT_OUTCOME_UNKNOWN",
      cause: f.replyError,
    });
    const pending = f.faults.pendingAppend;
    if (!pending) throw new Error("Missing undecided request");
    await f.store.appendUpdates(pending);
    expect(await f.readAll()).toHaveLength(1);
    const calls = f.faults.appendCalls;
    await expect(f.writer.accept(object("later"))).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    expect(f.faults.appendCalls).toBe(calls);
    expect(await f.readAll()).toHaveLength(1);
  } finally {
    await f.close();
  }
});

// 未知回执后的探测失败必须停写，游标重载成功不能冒充批次已经判定。
test("未知批次探测失败后禁止继续对象写入并保留原因", async () => {
  const f = await fixture();
  try {
    f.faults.unknownAppendOnce = true;
    f.faults.failProbeReadOnce = true;
    let failure: unknown;
    try {
      await f.writer.accept(object("pending"));
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN", cause: f.probeError });
    expect(await f.readAll()).toEqual([]);
    const calls = f.faults.appendCalls;
    await expect(f.writer.accept(object("after"))).rejects.toMatchObject({ code: "COMMIT_OUTCOME_UNKNOWN" });
    expect(f.faults.appendCalls).toBe(calls);
  } finally {
    await f.close();
  }
});

// 新写者的恢复也可能再遇额度拒绝，同一实例下一次必须重新依据固定路由完成封口。
test("恢复封口再次被拒后同一 writer 可重新接管并完成交接", async () => {
  const f = await fixture();
  try {
    await f.writer.accept(object("before"));
    f.faults.failSeal = true;
    await expect(f.writer.seal()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    await expect(f.reopen()).rejects.toMatchObject({ code: "ADMISSION_REJECTED" });
    f.faults.failSeal = false;
    await f.writer.acquire();
    await f.writer.accept(object("after"));
    expect(await f.readAll()).toHaveLength(2);
  } finally {
    f.faults.failSeal = false;
    await f.close();
  }
});
