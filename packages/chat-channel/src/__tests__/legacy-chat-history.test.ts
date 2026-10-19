// packages/chat-channel/src/__tests__/legacy-chat-history.test.ts
// 旧 Chat Doc → 稳定历史记录的映射：终态过滤、只取可见正文、切片不拆代理对、历史源延迟打开。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  createLegacyChatHistorySource,
  LEGACY_HISTORY_PART_CHARS,
  readLegacyCommittedHistory,
} from "../channel/legacy-chat-history";
import { appendEntryText, ensureEntry, initChatDocStructure, setEntryStatus } from "../state/chat-writer";

function emptyChat(): Y.Doc {
  const ydoc = new Y.Doc();
  initChatDocStructure(ydoc);
  return ydoc;
}

function addEntry(
  ydoc: Y.Doc,
  entryId: string,
  role: "user" | "assistant" | "system",
  status: "pending" | "streaming" | "completed" | "cancelled" | "error",
  text: string,
): void {
  ensureEntry(ydoc, { entryId, turnId: entryId.split(":")[0] ?? null, kind: "message", role });
  appendEntryText(ydoc, entryId, "text:1", "text", text);
  setEntryStatus(ydoc, entryId, status);
}

describe("readLegacyCommittedHistory", () => {
  // 只有终态条目能封成历史；pending/streaming 仍在增长，导入会制造不可修正的截断。
  test("只导入终态条目，跳过进行中与非消息角色", () => {
    const ydoc = emptyChat();
    addEntry(ydoc, "turn-1:user", "user", "completed", "question");
    addEntry(ydoc, "turn-2:assistant", "assistant", "streaming", "still writing");
    addEntry(ydoc, "turn-3:assistant", "assistant", "error", "failed answer");
    addEntry(ydoc, "turn-4:user", "user", "pending", "queued");
    addEntry(ydoc, "turn-5:system", "system", "completed", "system note");
    const records = readLegacyCommittedHistory(ydoc);
    expect(records.map((record) => record.value)).toEqual(["question", "failed answer"]);
    expect(records.map((record) => record.meta)).toEqual([
      { kind: "text_part", entryId: "turn-1:user", contentSlot: 0, partIndex: 0 },
      { kind: "text_part", entryId: "turn-3:assistant", contentSlot: 0, partIndex: 0 },
    ]);
    ydoc.destroy();
  });

  // 工具与 reasoning 不是可见正文：只拼 `type: "text"` 的 Y.Text，空正文条目整体跳过。
  test("只读取 text 块，忽略 reasoning 与空条目", () => {
    const ydoc = emptyChat();
    addEntry(ydoc, "turn-1:assistant", "assistant", "completed", "answer");
    appendEntryText(ydoc, "turn-1:assistant", "reasoning:1", "reasoning", "thinking");
    addEntry(ydoc, "turn-2:assistant", "assistant", "completed", "");
    const records = readLegacyCommittedHistory(ydoc);
    expect(records.map((record) => record.value)).toEqual(["answer"]);
    ydoc.destroy();
  });

  // 长正文按代码单元切片，partIndex 连续；代理对不得被拆到两个记录。
  test("长正文切片保持 partIndex，且不拆代理对", () => {
    const ydoc = emptyChat();
    addEntry(ydoc, "turn-1:user", "user", "completed", "a😀b");
    const records = readLegacyCommittedHistory(ydoc, 2);
    expect(records.map((record) => record.value)).toEqual(["a", "😀", "b"]);
    expect(records.map((record) => (record.meta.kind === "text_part" ? record.meta.partIndex : -1))).toEqual([0, 1, 2]);
    expect(records.every((record) => record.meta.kind === "text_part" && record.meta.contentSlot === 0)).toBe(true);
    ydoc.destroy();
  });

  // 顺序严格按 entryOrder；默认切片上限是导出常量。
  test("按 entryOrder 输出，默认片段上限可导出", () => {
    const ydoc = emptyChat();
    addEntry(ydoc, "turn-1:user", "user", "completed", "first");
    addEntry(ydoc, "turn-1:assistant", "assistant", "cancelled", "second");
    const records = readLegacyCommittedHistory(ydoc);
    expect(records.map((record) => record.value)).toEqual(["first", "second"]);
    expect(LEGACY_HISTORY_PART_CHARS).toBeGreaterThan(0);
    ydoc.destroy();
  });
});

describe("createLegacyChatHistorySource", () => {
  // 已打开的旧 Doc 直接读取，不重复 open；ACP 会话标识缺省时用空字符串，不阻止导入。
  test("优先读取已打开 Doc", async () => {
    const ydoc = emptyChat();
    addEntry(ydoc, "turn-1:user", "user", "completed", "existing");
    let opened = 0;
    const source = createLegacyChatHistorySource({
      docs: {
        getChat: () => ({ ydoc }),
        openChat: async () => {
          opened += 1;
          return { ydoc: new Y.Doc() };
        },
      },
      rcsSessionId: "rcs-source",
      acpSessionId: null,
    });
    expect(source.acpSessionId).toBe("");
    expect((await source.read()).map((record) => record.value)).toEqual(["existing"]);
    expect(opened).toBe(0);
    ydoc.destroy();
  });

  // 未打开时经 openChat 创建；调用方给出的 ACP 标识原样透传。
  test("未打开时通过 openChat 读取", async () => {
    const ydoc = emptyChat();
    addEntry(ydoc, "turn-1:assistant", "assistant", "completed", "opened");
    const source = createLegacyChatHistorySource({
      docs: {
        getChat: () => undefined,
        openChat: async () => ({ ydoc }),
      },
      rcsSessionId: "rcs-source",
      acpSessionId: "ses_1",
    });
    expect(source.acpSessionId).toBe("ses_1");
    expect((await source.read()).map((record) => record.value)).toEqual(["opened"]);
    ydoc.destroy();
  });
});
