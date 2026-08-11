import { describe, expect, test } from "bun:test";
import { stripHtmlTags, stripSystemReminderContent } from "../lib/strip-html-tags";

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

describe("stripSystemReminderContent", () => {
  // 用户消息末尾的完整 system-reminder 块不应展示给用户。
  test("移除用户消息中的完整 system-reminder 块", () => {
    expect(
      stripSystemReminderContent(
        "帮我修复这个问题\n<system-reminder>Current permission mode: Bypass</system-reminder>",
      ),
    ).toBe("帮我修复这个问题");
  });

  // 用户消息被截断在 system-reminder 内部时，截断后的残片也不应展示。
  test("移除截断的 system-reminder 及其后续内容", () => {
    expect(stripSystemReminderContent("帮我修复这个问题\n<system-reminder>\nCurrent permission mode: Byp")).toBe(
      "帮我修复这个问题",
    );
  });
});
