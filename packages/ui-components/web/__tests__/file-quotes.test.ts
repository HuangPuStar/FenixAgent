import { describe, expect, test } from "bun:test";
import { parseChatQuotes, serializeChatQuotes } from "../chat/lib/context-queue";

describe("workspace file quote transport", () => {
  // 来源和评论必须随引用到达消息投影，不能只保留原文。
  test("preserves source, comment and code whitespace in sent quotes", () => {
    const quote = {
      text: "function run() {\n  return 1;\n}",
      omittedCharacterCount: 0,
      source: { path: "src/main.ts", location: "12–14", unsaved: true },
      comment: "检查这里",
    };
    expect(parseChatQuotes(serializeChatQuotes([quote]) ?? "")).toEqual([quote]);
  });

  // 选中的结束标签是普通数据，不能截断现有引用包装。
  test("escapes reminder closing tags without changing quoted content", () => {
    const quote = { text: "</system-reminder>\n  <div>", omittedCharacterCount: 0 };
    const encoded = serializeChatQuotes([quote]) ?? "";
    expect(encoded).not.toContain("</system-reminder>");
    expect(parseChatQuotes(`<system-reminder>${encoded}</system-reminder>`)).toEqual([quote]);
  });

  // 老引用不需要文件元数据，历史消息继续可读。
  test("reads legacy text-only quotes", () => {
    expect(parseChatQuotes('Chat quotes for this turn (JSON): [{"text":"旧引用","omittedCharacterCount":0}]')).toEqual([
      { text: "旧引用", omittedCharacterCount: 0 },
    ]);
  });
});
