// 本文件是这组纯函数（Chat 引用的长度限制 / 序列化 / 可见性判定）在仓内的唯一覆盖：
// 函数真身已随 Phase 1 迁到 `@fenix/ui-components/chat/lib/context-queue`，这里只保留纯函数用例；
// 有状态上下文队列（pushContext / removeContext / flushContext / clearContextQueue）的用例
// 已随实现迁至 `@fenix/web-runtime/web/__tests__/context-queue.test.ts`。
// 已知欠账：待 ui-components 自带测试覆盖这组纯函数后，删除本文件。
import { describe, expect, test } from "bun:test";

const {
  MAX_QUOTED_TEXT_LENGTH,
  MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH,
  isVisibleContentBlock,
  limitQuotedText,
  parseChatQuotes,
  serializeChatQuotes,
} = await import("@fenix/ui-components/chat/lib/context-queue");

describe("context-queue", () => {
  // 超长引用必须在进入上下文队列前截断，避免把整段聊天输出传给 Agent。
  test("limitQuotedText 限制超长引用并报告省略字符数", () => {
    const source = `${"甲".repeat(MAX_QUOTED_TEXT_LENGTH)}后续内容`;
    const result = limitQuotedText(source);

    expect(Array.from(result.text)).toHaveLength(MAX_QUOTED_TEXT_LENGTH);
    expect(result.text.endsWith("甲")).toBe(true);
    expect(result.text).not.toContain("后续内容");
    expect(result.omittedCharacterCount).toBe(4);
  });

  // 剩余总预算小于单条上限时，调用方可进一步收紧本条引用且仍得到准确省略量。
  test("limitQuotedText 支持单轮引用总预算", () => {
    expect(limitQuotedText("一二三四五", 3)).toEqual({ text: "一二三", omittedCharacterCount: 2 });
  });

  // 结构化引用序列化必须受完整 payload 上限保护，并能从 reminder 中稳定恢复。
  test("serializeChatQuotes 限制并恢复结构化引用", () => {
    const serialized = serializeChatQuotes([
      { text: "第一段引用", omittedCharacterCount: 0 },
      { text: "引".repeat(MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH), omittedCharacterCount: 20 },
    ]);
    expect(serialized).toBeDefined();
    expect(Array.from(serialized!).length).toBeLessThanOrEqual(MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH);
    expect(parseChatQuotes(`<system-reminder>\n${serialized}\n</system-reminder>`)).toEqual([
      { text: "第一段引用", omittedCharacterCount: 0 },
    ]);
  });

  // 引用规范化保持紧凑，且 Unicode 截断不能切坏 emoji 的代理对。
  test("limitQuotedText 规范化空白并按 Unicode 字符截断", () => {
    expect(limitQuotedText("  第一行\n\n 第二行  ")).toEqual({ text: "第一行 第二行", omittedCharacterCount: 0 });
    const result = limitQuotedText(`${"a".repeat(MAX_QUOTED_TEXT_LENGTH - 1)}😀结尾`);
    expect(result.text.endsWith("😀")).toBe(true);
    expect(result.omittedCharacterCount).toBe(2);
  });
});

describe("isVisibleContentBlock", () => {
  test("text block 包含完整 system-reminder 标签时返回 false", () => {
    expect(isVisibleContentBlock({ type: "text", text: "<system-reminder>xxx</system-reminder>" })).toBe(false);
  });

  test("text block 标签前后有空白时返回 false", () => {
    expect(isVisibleContentBlock({ type: "text", text: "  <system-reminder>xxx</system-reminder>  " })).toBe(false);
  });

  test("text block 标签内部有换行时返回 false", () => {
    expect(isVisibleContentBlock({ type: "text", text: "<system-reminder>\nline1\nline2\n</system-reminder>" })).toBe(
      false,
    );
  });

  test("普通文本 text block 返回 true", () => {
    expect(isVisibleContentBlock({ type: "text", text: "hello" })).toBe(true);
  });

  test("文本中包含但不完整包裹 system-reminder 时返回 true", () => {
    expect(isVisibleContentBlock({ type: "text", text: "这里提到了 <system-reminder> 但不是完整包裹" })).toBe(true);
  });

  test("只有开始标签没有结束标签时返回 true", () => {
    expect(isVisibleContentBlock({ type: "text", text: "<system-reminder>some content" })).toBe(true);
  });

  test("非 text 类型 block 返回 true", () => {
    expect(isVisibleContentBlock({ type: "image" } as { type: string; text?: string })).toBe(true);
  });
});
