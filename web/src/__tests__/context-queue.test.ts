import { describe, expect, test } from "bun:test";

const { pushContext, removeContext, flushContext, clearContextQueue, isVisibleContentBlock } = await import(
  "../lib/context-queue"
);

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
