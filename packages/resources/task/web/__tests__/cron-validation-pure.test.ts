// cron 校验的两个形态：2026-09-22 收敛为一处实现（`agent-tasks-utils.validateCronExpression` 给文案，
// `isValidCronExpression` 由它派生给 `superRefine` 用），此前 `CronEditor` 与 `agent-tasks-utils`
// 各写一份同样的「切 5 段 + parseExpression」。
//
// 本用例把**改造前的布尔实现**原样留作参照，逐例断言「文案形态的布尔投影 === 原实现」，
// 并钉住文案形态的三种措辞。收敛的判据是行为等价，不是函数形状一致——两处分支顺序本就不同
// （文案形态先判空值、布尔形态先判字段数），等价性来自「空串切出 `[""]`、长度 1 ≠ 5」这条重叠。

import { describe, expect, test } from "bun:test";
import { parseExpression } from "cron-parser";
import { validateCronExpression } from "../pages/agent-panel/pages/agent-tasks-utils";

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

describe("cron 校验：文案形态的措辞不变", () => {
  test("空值 / 字段数 / 解析失败三种措辞与成功时的 undefined", () => {
    expect(validateCronExpression("", "")).toBe("Cron 不能为空");
    expect(validateCronExpression("   ", "")).toBe("Cron 不能为空");
    expect(validateCronExpression("* * * *", "")).toBe("Cron 表达式必须为 5 个字段");
    expect(validateCronExpression("61 * * * *", "")).toBe("Cron 表达式无效，请检查字段取值范围");
    expect(validateCronExpression("*/5 * * * *", "Asia/Shanghai")).toBeUndefined();
  });
});
