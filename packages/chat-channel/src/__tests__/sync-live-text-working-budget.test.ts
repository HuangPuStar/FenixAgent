import { expect, test } from "bun:test";
import { textWorkingFixture } from "./sync-live-text-working-fixture";
import { rejection, text } from "./sync-live-writer-authority-fixture";
import { semantic } from "./sync-live-writer-fixture";

// 共享池中的两个 scope 都已确认正文，前一个提交占用常驻索引后仍须留足第二个的工作额度。
test("两个 scope 共享 controlIndex 填满接纳额度后仍依次提交全部已接纳正文", async () => {
  const f = await textWorkingFixture();
  const accepted = [0, 0];
  let refused = false;
  try {
    for (let round = 0; round < 100000 && !refused; round++) {
      for (const index of [0, 1]) {
        const result = await rejection(
          f.writers[index]!.accept({ ...text(`scope-${index}`), delta: "x", idempotent: false }),
        );
        if (result === undefined) accepted[index]!++;
        else {
          expect(result).toHaveProperty("code", "ADMISSION_REJECTED");
          refused = true;
          break;
        }
      }
    }
    expect(refused).toBe(true);
    expect(accepted[0]).toBeGreaterThan(1000);
    expect(accepted[1]).toBeGreaterThan(1000);
    expect(await f.texts(0)).toEqual([]);
    expect(await f.texts(1)).toEqual([]);
    for (const index of [0, 1]) {
      await f.writers[index]!.accept(semantic("tool", { entityId: `scope-${index}` }));
      expect((await f.texts(index)).join("")).toBe("x".repeat(accepted[index]!));
    }
    expect(f.admission.used("ingressSpool")).toBe(0);
  } finally {
    await f.close();
  }
  expect(f.admission.used("controlIndex")).toBe(0);
});
