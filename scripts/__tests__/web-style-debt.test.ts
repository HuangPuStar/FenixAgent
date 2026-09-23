import { expect, test } from "bun:test";

import { checkWebStyle } from "../check-web-style";
import {
  buildWebStyleDebt,
  compareWebStyleDebt,
  debtFingerprint,
  type WebStyleDebtEntry,
  type WebStyleDebtLedger,
} from "../lib/web-style-debt";
import type { WebStyleRuleId, WebStyleViolation } from "../lib/web-style-rules";

/**
 * 存量台账（棘轮）的自测。
 *
 * 台账是「不让门禁一上线就全红」的唯一手段，因此它的判定方向必须被锁住：
 * 未登记 = 新增（失败）、上升 = 新增（失败）、下降 = 放行（只提示）。
 * 三个方向里任何一个被写反，门禁要么形同虚设，要么会拦住正常清理。
 */

function ledgerOf(entries: WebStyleDebtEntry[]): WebStyleDebtLedger {
  return { entries: new Map(entries.map((entry) => [debtFingerprint(entry.rule, entry.directory), entry])) };
}

function violation(ruleId: WebStyleRuleId, filePath: string, token: string): WebStyleViolation {
  return { ruleId, filePath, line: 1, column: 1, token };
}

const ENTRY: WebStyleDebtEntry = {
  rule: "FCP-WEB-01",
  directory: "apps/web/src/shell",
  count: 2,
  owner: "未排期",
};

// 台账里没有的目录出现命中就是新增违规——这是门禁阻断新代码的主路径。
test("未登记目录的命中判为新增", () => {
  const comparison = compareWebStyleDebt(
    [violation("FCP-WEB-01", "apps/web/src/other/panel.tsx", "text-[12px]")],
    ledgerOf([ENTRY]),
  );

  expect(comparison.unregistered).toHaveLength(1);
  expect(comparison.unregistered[0]?.directory).toBe("apps/web/src/other");
  expect(comparison.increases).toEqual([]);
});

// 已登记目录的命中数上升同样是新增：棘轮只降不升，否则「已登记」会变成永久豁免。
test("已登记目录的命中数上升判为违反棘轮", () => {
  const comparison = compareWebStyleDebt(
    [
      violation("FCP-WEB-01", "apps/web/src/shell/a.tsx", "text-[12px]"),
      violation("FCP-WEB-01", "apps/web/src/shell/b.tsx", "text-[10px]"),
      violation("FCP-WEB-01", "apps/web/src/shell/c.tsx", "gap-[3px]"),
    ],
    ledgerOf([ENTRY]),
  );

  expect(comparison.increases).toHaveLength(1);
  expect(comparison.increases[0]).toMatchObject({ actual: 3 });
  expect(comparison.unregistered).toEqual([]);
});

// 清理后命中数下降必须放行：否则每次清理都要先改台账，维护者会转而选择不动存量。
test("命中数下降只提示不阻断", () => {
  const comparison = compareWebStyleDebt(
    [violation("FCP-WEB-01", "apps/web/src/shell/a.tsx", "text-[12px]")],
    ledgerOf([ENTRY]),
  );

  expect(comparison.decreases).toHaveLength(1);
  expect(comparison.decreases[0]).toMatchObject({ actual: 1 });
  expect(comparison.unregistered).toEqual([]);
  expect(comparison.increases).toEqual([]);
});

// 命中数与台账一致时三条结论都为空，门禁静默通过。
test("命中数与台账一致时无任何结论", () => {
  const comparison = compareWebStyleDebt(
    [
      violation("FCP-WEB-01", "apps/web/src/shell/a.tsx", "text-[12px]"),
      violation("FCP-WEB-01", "apps/web/src/shell/b.tsx", "text-[10px]"),
    ],
    ledgerOf([ENTRY]),
  );

  expect(comparison).toMatchObject({ unregistered: [], increases: [], decreases: [], registeredTotal: 2 });
});

// 台账条目按「规则 + 目录」生成，计数等于该目录内的命中数；同目录不同规则各占一条。
test("生成台账时按规则与目录分组计数", () => {
  const entries = buildWebStyleDebt([
    violation("FCP-WEB-01", "apps/web/src/shell/a.tsx", "text-[12px]"),
    violation("FCP-WEB-01", "apps/web/src/shell/b.tsx", "gap-[3px]"),
    violation("FCP-WEB-02", "apps/web/src/shell/a.tsx", "[&>span]:size-8"),
  ]);

  expect(entries).toEqual([
    { rule: "FCP-WEB-01", directory: "apps/web/src/shell", count: 2, owner: "未排期" },
    { rule: "FCP-WEB-02", directory: "apps/web/src/shell", count: 1, owner: "未排期" },
  ]);
});

// 当前仓库必须与台账一致：新增违规在测试阶段就炸响，不必等到 precheck 或 review。
test("当前仓库的样式命中与存量台账一致", async () => {
  expect(await checkWebStyle()).toBe(0);
});
