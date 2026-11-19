import { expect, test } from "bun:test";
import { authorityFixture, rejection, text } from "./sync-live-writer-authority-fixture";

for (const stage of ["input", "body", "credit"] as const) {
  // 真实预留边界同步重入close后，尚未进入merge的输入必须拒绝，不能确认成功后退休丢文。
  test(`在${stage}预留时关闭不会确认已丢弃的新正文`, async () => {
    const f = await authorityFixture();
    const reserve = f.admission.reserve.bind(f.admission);
    let closing: Promise<void> | undefined,
      controls = 0,
      armed = true;
    f.admission.reserve = (pool, bytes, credit) => {
      if (pool === "controlIndex") controls++;
      if (
        armed &&
        ((stage === "input" && controls === 1) ||
          (stage === "body" && pool === "ingressSpool") ||
          (stage === "credit" && controls === 2))
      ) {
        armed = false;
        closing = f.writer.close();
      }
      return reserve(pool, bytes, credit);
    };
    try {
      const result = await rejection(f.writer.accept({ ...text("closing"), delta: "x", idempotent: false }));
      expect(result).toHaveProperty("code", "WRITER_EPOCH_LOST");
      await closing;
      expect(await f.readAll()).toEqual([]);
      expect(f.admission.used("ingressSpool")).toBe(0);
    } finally {
      armed = false;
      f.admission.reserve = reserve;
      if (closing) await closing;
      await f.close();
    }
    expect(f.admission.used("controlIndex")).toBe(0);
  });
}

// 原缓冲扩窗时关闭，只提交先前已确认内容，失败的新chunk须连同本次临时扩额一起撤回。
test("joining扩额重入close只持久化旧缓冲并归还新预留", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  await f.writer.accept({ ...text("joining"), delta: "prior", idempotent: false });
  const reserve = f.admission.reserve.bind(f.admission);
  let closing: Promise<void> | undefined,
    controls = 0;
  f.admission.reserve = (pool, bytes, credit) => {
    if (pool === "controlIndex" && ++controls === 2) closing = f.writer.close();
    return reserve(pool, bytes, credit);
  };
  try {
    const result = await rejection(
      f.writer.accept({ ...text("joining"), delta: "x".repeat(16384), idempotent: false }),
    );
    expect(result).toHaveProperty("code", "WRITER_EPOCH_LOST");
    await closing;
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload))).toEqual(["prior"]);
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    f.admission.reserve = reserve;
    if (closing) await closing;
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});

// 同键内层输入已确认后，外层失败的临时扩窗回滚必须保留内层已接纳正文所需的工作承诺。
test("外层扩窗回滚仍资助同窗口内层已确认输入", async () => {
  const f = await authorityFixture({ maxBytes: 1 << 20 });
  const reserve = f.admission.reserve.bind(f.admission);
  await f.writer.accept({ ...text("shared"), delta: "old", idempotent: false });
  let armed = true,
    controls = 0,
    nested: Promise<unknown> | undefined;
  let blocker: ReturnType<typeof reserve> | undefined;
  f.admission.reserve = (pool, bytes, credit) => {
    if (pool === "controlIndex") controls++;
    if (armed && pool === "controlIndex" && controls === 2) {
      armed = false;
      nested = rejection(f.writer.accept({ ...text("shared"), delta: "i".repeat(16384), idempotent: false }));
    }
    return reserve(pool, bytes, credit);
  };
  try {
    const outer = await rejection(f.writer.accept({ ...text("shared"), delta: "o".repeat(32768), idempotent: false }));
    expect(outer).toHaveProperty("code", "WRITER_EPOCH_LOST");
    expect(await nested).toBeUndefined();
    blocker = reserve("controlIndex", f.admission.available("controlIndex"));
    expect(await rejection(f.writer.close())).toBeUndefined();
    expect((await f.readAll()).map((record) => new TextDecoder().decode(record.payload)).join("")).toBe(
      `old${"i".repeat(16384)}`,
    );
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    armed = false;
    f.admission.reserve = reserve;
    blocker?.release();
    if (nested) await nested;
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});
