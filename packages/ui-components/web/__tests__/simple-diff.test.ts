import { describe, expect, test } from "bun:test";
import { computeLineDiff } from "../chat/lib/simple-diff";

/**
 * 工具 diff 行级投影的纯函数测试。
 *
 * 覆盖 UI 依赖的五类结果：相同文本无变化、增删行统计、上下文压缩省略、超大文件退化截断、
 * 以及新增文件（旧文本为空）与 CRLF 归一化。
 */

describe("工具 diff 投影", () => {
  // 文本完全一致时不应产生任何展示行，调用方据此隐藏 diff 区域。
  test("相同文本返回空 diff", () => {
    const diff = computeLineDiff("a\nb", "a\nb");

    expect(diff.lines).toEqual([]);
    expect(diff.added).toBe(0);
    expect(diff.removed).toBe(0);
    expect(diff.truncated).toBe(false);
  });

  // 单行替换应输出「上下文 + 删除 + 新增 + 上下文」，并统计增删行数。
  test("生成最小增删行并保留上下文", () => {
    const diff = computeLineDiff("a\nb\nc", "a\nx\nc");

    expect(diff.lines).toEqual([
      { type: "context", text: "a" },
      { type: "remove", text: "b" },
      { type: "add", text: "x" },
      { type: "context", text: "c" },
    ]);
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.truncated).toBe(false);
  });

  // 新增文件没有旧文本，所有行都是新增。
  test("旧文本为空时全部记为新增", () => {
    const diff = computeLineDiff(null, "one\ntwo\nthree");

    expect(diff.lines).toEqual([
      { type: "add", text: "one" },
      { type: "add", text: "two" },
      { type: "add", text: "three" },
    ]);
    expect(diff.added).toBe(3);
    expect(diff.removed).toBe(0);
  });

  // 远离变化的连续上下文必须折叠为一条省略行，只保留变化附近的行。
  test("压缩长上下文并标记截断", () => {
    const before = Array.from({ length: 20 }, (_, index) => `line-${index}`);
    const after = [...before];
    after[10] = "line-10-changed";

    const diff = computeLineDiff(before.join("\n"), after.join("\n"), 1);
    const ellipsis = diff.lines.filter((line) => line.type === "ellipsis");

    expect(ellipsis).toHaveLength(2);
    expect(ellipsis.every((line) => (line.hiddenCount ?? 0) > 0)).toBe(true);
    expect(diff.lines.some((line) => line.type === "remove" && line.text === "line-10")).toBe(true);
    expect(diff.lines.some((line) => line.type === "add" && line.text === "line-10-changed")).toBe(true);
    expect(diff.truncated).toBe(true);
  });

  // 超大文件超出 LCS 计算阈值时退化为「删除段 + 新增段」，并限制展示行数。
  test("超大文件退化展示并截断", () => {
    const before = Array.from({ length: 450 }, (_, index) => `old-${index}`).join("\n");
    const after = Array.from({ length: 450 }, (_, index) => `new-${index}`).join("\n");

    const diff = computeLineDiff(before, after);

    expect(diff.truncated).toBe(true);
    expect(diff.lines).toHaveLength(240);
    expect(diff.removed).toBe(120);
    expect(diff.added).toBe(120);
  });

  // CRLF 输入必须按 LF 归一化，避免每行都被判定为变化。
  test("统一 CRLF 换行", () => {
    const diff = computeLineDiff("a\r\nb\r\nc", "a\nb\nc");

    expect(diff.lines).toEqual([]);
    expect(diff.truncated).toBe(false);
  });
});
