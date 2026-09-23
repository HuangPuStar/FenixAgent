// cron 校验的两个形态：2026-09-22 收敛为一处实现（`agent-tasks-utils.validateCronExpression` 给失败原因，
// `isValidCronExpression` 由它派生给 `superRefine` 用），此前 `CronEditor` 与 `agent-tasks-utils`
// 各写一份同样的「切 5 段 + parseExpression」。
//
// 本用例把**改造前的布尔实现**原样留作参照，逐例断言「文案形态的布尔投影 === 原实现」，
// 并钉住文案形态的三种失败各有一个字典键。收敛的判据是行为等价，不是函数形状一致——两处分支顺序本就不同
// （文案形态先判空值、布尔形态先判字段数），等价性来自「空串切出 `[""]`、长度 1 ≠ 5」这条重叠。
//
// 2026-09-23（第 19 轮）：返回值由中文文案改成字典键（`error.cron*`），判定与分支顺序未动。

import { describe, expect, test } from "bun:test";
import { parseExpression } from "cron-parser";
import { validateCronExpression } from "../pages/agent-panel/pages/agent-tasks-utils";
import { enFlat, zhFlat } from "./cron-text-stub";

/** 改造前 `agent-tasks-utils` 的布尔实现（原文保留，作为等价性参照）。 */
function isValidCronExpressionBefore(cron: string, timezone: string): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  try {
    parseExpression(cron, timezone.trim() ? { tz: timezone.trim() } : undefined);
    return true;
  } catch {
    return false;
  }
}

const CASES: ReadonlyArray<readonly [string, string]> = [
  ["", ""],
  ["   ", ""],
  ["* * * * *", ""],
  ["*/5 * * * *", "Asia/Shanghai"],
  ["0 9 * * *", " UTC "],
  [" 0 9 * * * ", "Asia/Shanghai"],
  ["0 0 1 * * *", ""],
  ["* * * *", ""],
  ["61 * * * *", ""],
  ["0 9 31 2 *", ""],
  ["not a cron at all", ""],
  ["0 9 * * 1-5", "Not/AZone"],
];

describe("cron 校验：布尔派生与原实现逐例同值", () => {
  for (const [cron, timezone] of CASES) {
    test(`${JSON.stringify(cron)} / ${JSON.stringify(timezone)}`, () => {
      const actual = validateCronExpression(cron, timezone) === undefined;
      const before = isValidCronExpressionBefore(cron, timezone);
      expect(actual).toBe(before);
    });
  }
});

describe("cron 校验：三种失败各自返回可翻译的键", () => {
  // 2026-09-23（第 19 轮）起返回值是字典键而不是中文：三种失败的措辞仍各不相同（差在哪要说得出来），
  // 但文案本身由视图层按当前语言取——这里同时钉住「键在包内字典里查得到且不是中文」。
  test("空值 / 字段数 / 解析失败三种键与成功时的 undefined", () => {
    expect(validateCronExpression("", "")).toBe("error.cronRequired");
    expect(validateCronExpression("   ", "")).toBe("error.cronRequired");
    expect(validateCronExpression("* * * *", "")).toBe("error.cronFieldCount");
    expect(validateCronExpression("61 * * * *", "")).toBe("error.cronInvalid");
    expect(validateCronExpression("*/5 * * * *", "Asia/Shanghai")).toBeUndefined();

    for (const key of ["error.cronRequired", "error.cronFieldCount", "error.cronInvalid"]) {
      expect(zhFlat.get(key), `字典缺少键 ${key}`).toBeTruthy();
      expect(enFlat.get(key), `字典缺少键 ${key}`).toBeTruthy();
      expect(key).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
