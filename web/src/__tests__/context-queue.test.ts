import { describe, expect, test } from "bun:test";

const {
  MAX_QUOTED_TEXT_LENGTH,
  MAX_QUOTE_CONTEXT_PAYLOAD_LENGTH,
  pushContext,
  removeContext,
  flushContext,
  clearContextQueue,
  isVisibleContentBlock,
  limitQuotedText,
  parseChatQuotes,
  serializeChatQuotes,
} = await import("../lib/context-queue");

describe("context-queue", () => {
  test("flushContext 返回 null 当队列为空", () => {
    clearContextQueue();
    expect(flushContext()).toBeNull();
  });

  test("pushContext + flushContext 返回拼接的 system-reminder block", () => {
    clearContextQueue();
    pushContext("route", "当前页面: /agent/chat/agent-123");
    pushContext("session", "sessionId: ses-456");
    const result = flushContext();
    expect(result).not.toBeNull();
    expect(result!.startsWith("<system-reminder>")).toBe(true);
    expect(result!.endsWith("</system-reminder>")).toBe(true);
    expect(result).toContain("当前页面: /agent/chat/agent-123");
    expect(result).toContain("sessionId: ses-456");
  });

  test("flushContext 清空队列后再次 flush 返回 null", () => {
    clearContextQueue();
    pushContext("route", "test");
    flushContext();
    expect(flushContext()).toBeNull();
  });

  test("pushContext 覆盖同 key 的旧值", () => {
    clearContextQueue();
    pushContext("route", "旧页面");
    pushContext("route", "新页面");
    const result = flushContext();
    expect(result).toContain("新页面");
    expect(result).not.toContain("旧页面");
  });

  test("removeContext 移除指定 key", () => {
    clearContextQueue();
    pushContext("route", "页面");
    pushContext("session", "会话");
    removeContext("session");
    const result = flushContext();
    expect(result).toContain("页面");
    expect(result).not.toContain("会话");
  });

  test("removeContext 不存在的 key 不报错", () => {
    clearContextQueue();
    expect(() => removeContext("nonexistent")).not.toThrow();
  });

  // 意图：keep-alive 会话的引用上下文只能由对应会话消费，全局上下文仍可随当前会话发送。
  test("flushContext 隔离会话队列", () => {
    clearContextQueue();
    pushContext("route", "全局页面");
    pushContext("quote-a", "会话 A 引用", "session-a");
    pushContext("quote-b", "会话 B 引用", "session-b");

    const sessionA = flushContext("session-a");
    expect(sessionA).toContain("全局页面");
    expect(sessionA).toContain("会话 A 引用");
    expect(sessionA).not.toContain("会话 B 引用");
    expect(flushContext("session-a")).toBeNull();
    expect(flushContext("session-b")).toContain("会话 B 引用");
  });

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
