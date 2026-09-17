import { describe, expect, test } from "bun:test";
import { splitSystemReminderBlocks, stripHtmlTags } from "../lib/strip-html-tags";

describe("stripHtmlTags", () => {
  // 剔除成对的 <system-reminder> 块（含块内内容），这是标题最常见的污染源
  test("removes paired system-reminder block including inner content", () => {
    expect(stripHtmlTags("<system-reminder>使用工具前先确认</system-reminder>")).toBe("");
  });

  // 标题被截断在 system-reminder 块内部时，后续残片也属于系统上下文，不能继续展示。
  test("removes truncated system-reminder content through the end", () => {
    expect(stripHtmlTags("修复登录 <system-reminder>\nCurrent permission mode: Byp")).toBe("修复登录");
  });

  // 标题为正常文本拼接 system-reminder 块时，保留正常文本
  test("keeps normal text around a system-reminder block", () => {
    expect(stripHtmlTags("清理代码库 <system-reminder>先读 README</system-reminder>")).toBe("清理代码库");
  });

  // 剔除孤立的开标签（只有 <system-reminder> 没有闭标签）
  test("removes orphan opening tag", () => {
    expect(stripHtmlTags("修复登录 <system-reminder>")).toBe("修复登录");
  });

  // 剔除孤立的闭标签
  test("removes orphan closing tag", () => {
    expect(stripHtmlTags("</thinking> 修复登录")).toBe("修复登录");
  });

  // 常规 HTML 标签（带属性）只剔除标签本身，保留标签间文本
  test("removes generic tags with attributes but keeps inner text", () => {
    expect(stripHtmlTags('<p class="x"> 修复登录 </p>')).toBe("修复登录");
    expect(stripHtmlTags("标记 <b>重要</b> 修复")).toBe("标记 重要 修复");
  });

  // 标题全是标签时清洗后为空
  test("returns empty string when title is only tags", () => {
    expect(stripHtmlTags("<system-reminder></system-reminder>")).toBe("");
  });

  // 清洗结果已 trim
  test("trims surrounding whitespace", () => {
    expect(stripHtmlTags("  修复登录  ")).toBe("修复登录");
  });

  // 空值输入返回空字符串
  test("returns empty string for null/undefined/empty input", () => {
    expect(stripHtmlTags(null)).toBe("");
    expect(stripHtmlTags(undefined)).toBe("");
    expect(stripHtmlTags("")).toBe("");
  });

  // 普通文本原样保留（含比较符号，不误伤 "a < b" 这类内容）
  test("keeps plain text with comparison operators untouched", () => {
    expect(stripHtmlTags("1 < 2 的含义")).toBe("1 < 2 的含义");
  });
});

describe("splitSystemReminderBlocks", () => {
  // 发送方把上下文块 unshift 在用户文本最前：开头完整块切为 system 段，用户文本保留为 text 段
  test("切分开头注入的完整 system-reminder 块", () => {
    expect(
      splitSystemReminderBlocks(
        "<system-reminder>\nCurrent permission mode: Bypass\n</system-reminder>\n帮我修复这个问题",
      ),
    ).toEqual([
      { kind: "system", text: "<system-reminder>\nCurrent permission mode: Bypass\n</system-reminder>" },
      { kind: "text", text: "帮我修复这个问题" },
    ]);
  });

  // 开头的上下文块被截断（丢失闭标签）时，其后内容同属系统上下文，切为 system 段
  test("开头截断的 system-reminder 切为 system 段", () => {
    expect(splitSystemReminderBlocks("<system-reminder>\nCurrent permission mode: Byp")).toEqual([
      { kind: "system", text: "<system-reminder>\nCurrent permission mode: Byp" },
    ]);
  });

  // 用户输入中合法包含孤立开标签（无闭标签）时不得切分，只能按用户输入原样保留
  test("用户输入中的孤立 system-reminder 开标签保留为 text 段", () => {
    expect(splitSystemReminderBlocks("请解释 <system-reminder> 标签的用途")).toEqual([
      { kind: "text", text: "请解释 <system-reminder> 标签的用途" },
    ]);
  });

  // 用户粘贴了完整的 reminder 块作为讨论对象时，块切为 system 段，前后文本保留
  test("切分中间位置的完整 system-reminder 块", () => {
    expect(splitSystemReminderBlocks("这段内容:\n<system-reminder>\n工具权限受限\n</system-reminder>\n请分析")).toEqual(
      [
        { kind: "text", text: "这段内容:" },
        { kind: "system", text: "<system-reminder>\n工具权限受限\n</system-reminder>" },
        { kind: "text", text: "请分析" },
      ],
    );
  });

  // 多个完整块各自切为 system 段
  test("多个完整 system-reminder 块依次切分", () => {
    expect(
      splitSystemReminderBlocks("<system-reminder>a</system-reminder><system-reminder>b</system-reminder>"),
    ).toEqual([
      { kind: "system", text: "<system-reminder>a</system-reminder>" },
      { kind: "system", text: "<system-reminder>b</system-reminder>" },
    ]);
  });

  // 纯文本消息只有一个 text 段
  test("纯文本消息切为单个 text 段", () => {
    expect(splitSystemReminderBlocks("帮我修复这个问题")).toEqual([{ kind: "text", text: "帮我修复这个问题" }]);
  });

  // 空输入返回空数组
  test("空输入返回空数组", () => {
    expect(splitSystemReminderBlocks("")).toEqual([]);
    expect(splitSystemReminderBlocks("   ")).toEqual([]);
  });
});
