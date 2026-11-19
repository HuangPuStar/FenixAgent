import { expect, test } from "bun:test";
import { textInputReservations } from "../sync/capacity/text-plan-reservations";
import { SyncProtocolError } from "../sync/protocol/errors";
import { scopeKey } from "../sync/protocol/identity";
import { createLiveIngress } from "../sync/runtime/ingress";
import { authorityFixture, gate, rejection, text, withinDeadline } from "./sync-live-writer-authority-fixture";
import { semantic } from "./sync-live-writer-fixture";

// B 仍留在缓冲时只确认 B 的接纳，不能借 A 的失败回执让 ingress 丢掉已确认 B 的序号。
test("key 切换的小 B 不等待 A 的 flush 且保留自己的 ingress 回执", async () => {
  const f = await authorityFixture({ maxBytes: 64 });
  const ingress = createLiveIngress({ writer: f.writer, maxRecords: 4 });
  const paused = gate();
  const commit = f.store.commitContentBatch.bind(f.store);
  const refusal = new SyncProtocolError("ADMISSION_REJECTED", { message: "A flush temporarily refused" });
  let armed = true;
  f.store.commitContentBatch = async (input) => {
    if (armed) {
      paused.enter();
      await paused.released;
      throw refusal;
    }
    return await commit(input);
  };
  let pendingB: Promise<unknown> | undefined;
  try {
    await ingress.accept({ ...text("A"), kind: "text-delta", idempotent: false });
    let settled = false;
    pendingB = ingress.accept({ ...text("B"), kind: "text-delta", idempotent: false }).then((result) => {
      settled = true;
      return result;
    });
    await withinDeadline(paused.entered);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(true);
    expect(ingress.lastIngressSeq()).toBe(2);
    paused.release();
    expect(await pendingB).toHaveProperty("ingressSeq", 2);
    await expect(f.writer.accept(semantic("tool", { entityId: "tool" }))).rejects.toMatchObject({ cause: refusal });
    expect(await f.readAll()).toEqual([]);
    armed = false;
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["A", "B"]);
    expect(ingress.lastIngressSeq()).toBe(2);
  } finally {
    paused.release();
    armed = false;
    if (pendingB) await pendingB;
    await f.close();
  }
});

for (const firstAction of ["recover", "acquire"] as const) {
  // 同代安装完成后只收到确定未写拒绝，第二次 recover 必须能再尝试原窗口而不是丢失安装代次。
  test(`${firstAction} 安装后确定容量拒绝仍可再 recover 完整写入一次`, async () => {
    const f = await authorityFixture({ maxBytes: 1 << 20 });
    const commit = f.store.commitContentBatch.bind(f.store);
    const refusal = new SyncProtocolError("ADMISSION_REJECTED", { message: "replay refused once" });
    let first = true;
    f.store.commitContentBatch = async (input) => {
      if (first) {
        first = false;
        throw refusal;
      }
      return await commit(input);
    };
    try {
      await f.writer.accept({ ...text("retained"), idempotent: false });
      await expect(f.writer[firstAction]()).rejects.toMatchObject({ code: "ADMISSION_REJECTED", cause: refusal });
      expect(await f.readAll()).toEqual([]);
      await f.writer.recover();
      expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["retained"]);
      expect(f.admission.used("ingressSpool")).toBe(0);
    } finally {
      await f.close();
    }
  });
}

// 未能安装的新投影不能沿用旧 generation 开门，必须重新接管并完成真正的安装。
test("recover 安装阶段失败仍使投影失效而不是保留旧 generation", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const readPointer = f.store.readScopePointer.bind(f.store);
  const unavailable = new Error("projection installation unavailable");
  try {
    await f.writer.accept({ ...text("uninstalled"), idempotent: false });
    f.store.readScopePointer = () => Promise.reject(unavailable);
    expect(await rejection(f.writer.recover())).toBe(unavailable);
    f.store.readScopePointer = readPointer;
    await expect(f.writer.recover()).rejects.toHaveProperty("code", "WRITER_EPOCH_LOST");
    expect(await f.readAll()).toEqual([]);
    await f.writer.acquire();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["uninstalled"]);
  } finally {
    f.store.readScopePointer = readPointer;
    await f.close();
  }
});

// 投影已安装也不能把 unknown 回放解释成确定未写，后续 recover 和 close 继续暴露同一原错。
test("recover 安装后的 unknown 回放仍保持原结果停写", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const readUpdates = f.store.readUpdatesAfter.bind(f.store);
  const unavailable = new Error("unknown replay probe unavailable");
  let probing = false;
  f.store.commitContentBatch = async () => {
    probing = true;
    return { outcome: "unknown", frontiers: [] };
  };
  f.store.readUpdatesAfter = (...args) => (probing ? Promise.reject(unavailable) : readUpdates(...args));
  try {
    await f.writer.accept({ ...text("uncertain"), idempotent: false });
    const original = await rejection(f.writer.recover());
    expect(original).toHaveProperty("code", "COMMIT_OUTCOME_UNKNOWN");
    if (!(original instanceof Error)) throw new Error("missing original unknown replay result");
    expect(original.cause).toBe(unavailable);
    expect(await rejection(f.writer.recover())).toBe(original);
    expect(await rejection(f.writer.close())).toBe(original);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    probing = false;
    await f.close();
  }
});

// 不借助外部 blocker，已确认的小增量也不能把提交临时索引额度全部吃掉而形成永久自锁。
test("同窗口小增量填满接纳额度后仍可冲刷已接纳正文", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const pointer = await f.store.readScopePointer(scopeKey(f.scope));
  const generation = pointer!.currentGeneration!;
  const available = f.admission.available("controlIndex");
  let entryId = "x";
  for (let length = 1; length <= 256; length++) {
    const keyUnits = generation.length + "turn".length + length + "text".length + "text/plain".length;
    if (available % textInputReservations(keyUnits, 1).controlIndex < 128) {
      entryId = "x".repeat(length);
      break;
    }
  }
  let accepted = 0;
  let refused: unknown;
  try {
    for (; accepted < 100000; accepted++) {
      const result = await rejection(f.writer.accept({ ...text(entryId), delta: "x", idempotent: false }));
      if (result !== undefined) {
        refused = result;
        break;
      }
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(refused).toHaveProperty("code", "ADMISSION_REJECTED");
    expect(await f.readAll()).toEqual([]);
    await f.writer.accept(semantic("tool", { entityId: "tool" }));
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload)).join("")).toBe(
      "x".repeat(accepted),
    );
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await f.close();
  }
});
