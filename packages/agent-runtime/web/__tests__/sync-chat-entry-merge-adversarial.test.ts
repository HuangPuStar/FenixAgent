// packages/agent-runtime/web/__tests__/sync-chat-entry-merge-adversarial.test.ts
// 新旧双路正文合并的对抗回归：缺口跨工具定位、合成 id 全局唯一、同 id 异角色、空白正文、
// 乱序 legacy 安全降级、重复 merge 幂等，以及缺口属性检查（200 轮 × 7 种缺段组合）。
//
// 这些用例直接调用生产合并器与真实 SyncContentProjectionHub，不复制实现；断言用户可见正文
// 与精确的工具/文本顺序，不接受“只检查正文存在”的弱断言。

import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import * as Y from "yjs";
import { createSyncMessageMerger } from "../hooks/sync-chat-messages";
import { createSyncContentProjectionHub } from "../yjs/sync-doc-hub";

type Assistant = Extract<StructuredMessage, { type: "assistant_message" }>;

function assistant(id: string, text: string, ts = 10000): Assistant {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], ts, seq: 1 };
}

function tool(id: string): StructuredMessage {
  return { type: "tool_call", id, title: "Read", status: "complete", content: [] };
}

function user(id: string, content: string): StructuredMessage {
  return { type: "user_message", id, content, ts: 10000, seq: 0 };
}

function view(messages: readonly StructuredMessage[]): string[] {
  return messages.map((message) =>
    message.type === "assistant_message" ? `${message.id}=${textOf(message)}` : `${message.type}:${message.id}`,
  );
}

function textOf(message: StructuredMessage): string {
  return message.type === "assistant_message"
    ? message.chunks
        .filter((chunk) => chunk.type === "message")
        .map((chunk) => chunk.text)
        .join("")
    : "";
}

function body(messages: readonly StructuredMessage[]): string {
  return messages.map(textOf).join("");
}

function ids(messages: readonly StructuredMessage[]): string[] {
  return messages.map((message) => message.id);
}

describe("缺口定位：不得跨越未知工具边界", () => {
  // 缺中段：分段序号 0→2、其间恰好两个工具，缺失段 #1 必须落在 t1 与 t2 之间。
  test("缺中段时正文落在正确的两个工具之间", () => {
    const merged = createSyncMessageMerger()(
      [assistant("e", "A"), tool("t1"), tool("t2"), assistant("e#2", "C")],
      [assistant("e", "ABC", 0)],
    );
    expect(view(merged)).toEqual(["e=A", "tool_call:t1", "e#1=B", "tool_call:t2", "e#2=C"]);
    expect(body(merged)).toBe("ABC");
  });

  // 缺首段：首个已知段序号为 1、其前恰好一个工具，缺失的 #0 必须排在工具之前。
  test("缺首段时正文落在第一个工具之前", () => {
    const merged = createSyncMessageMerger()([tool("t1"), assistant("e#1", "B")], [assistant("e", "AB", 0)]);
    expect(view(merged)).toEqual(["e=A", "tool_call:t1", "e#1=B"]);
    expect(body(merged)).toBe("AB");
  });

  // 缺尾段：缺失正文从末段后第一个工具之后开始，后续工具保持在其后。
  test("缺尾段时正文落在末段后第一个工具之后", () => {
    const merged = createSyncMessageMerger()([assistant("e", "A"), tool("t1"), tool("t2")], [assistant("e", "AB", 0)]);
    expect(view(merged)).toEqual(["e=A", "tool_call:t1", "e#1=B", "tool_call:t2"]);
    expect(body(merged)).toBe("AB");
  });

  // 边界计数不一致（两个分段边界却只有一个工具）时不得猜测：整条 entry 退化为新投影单条消息。
  test("工具数与分段边界数不一致时安全降级且正文只出现一次", () => {
    const merged = createSyncMessageMerger()(
      [assistant("e", "A"), tool("t1"), assistant("e#2", "C")],
      [assistant("e", "ABC", 0)],
    );
    expect(ids(merged)).toEqual(["e", "t1"]);
    expect(body(merged)).toBe("ABC");
    expect(new Set(ids(merged)).size).toBe(ids(merged).length);
  });
});

describe("合成 id 与别名 key 的全局唯一性", () => {
  // 另一条新投影 entry 占用 e#1 时，合成尾段必须顺延到 e#2，正文 AB + XYZ 都可见。
  test("合成段 id 不得与另一条新投影 entry 冲突", () => {
    const merged = createSyncMessageMerger()(
      [assistant("e", "A"), tool("t")],
      [assistant("e", "AB", 0), assistant("e#1", "XYZ", 0)],
    );
    expect(view(merged)).toEqual(["e=A", "tool_call:t", "e#2=B", "e#1=XYZ"]);
    expect(body(merged)).toBe("ABXYZ");
    expect(new Set(ids(merged)).size).toBe(ids(merged).length);
  });

  // 工具 id 恰好是 e#1 时，合成尾段不得覆盖工具；工具与正文都保留。
  test("合成段 id 不得与工具 id 冲突", () => {
    const merged = createSyncMessageMerger()([assistant("e", "A"), tool("e#1")], [assistant("e", "AB", 0)]);
    expect(view(merged)).toEqual(["e=A", "tool_call:e#1", "e#2=B"]);
    expect(body(merged)).toBe("AB");
    expect(merged.some((message) => message.type === "tool_call" && message.id === "e#1")).toBe(true);
  });

  // 旧侧已有真实 id 为 sync:e 的助手消息时，新投影同 id 消息必须换用唯一 key，旧正文不得丢失。
  test("sync:{id} 别名不得覆盖旧侧真实消息", () => {
    const merged = createSyncMessageMerger()(
      [user("e", "问"), assistant("sync:e", "OLD", 0)],
      [assistant("e", "NEW", 0)],
    );
    expect(ids(merged)).toEqual(["e", "sync:e", "sync-ext:e"]);
    expect(body(merged)).toBe("OLDNEW");
    expect(new Set(ids(merged)).size).toBe(ids(merged).length);
  });

  // 合成 id 与别名 key 都不得与输入中的任何消息 id 重复。
  test("重复 merge 时合成 id 稳定且不与输入 id 冲突", () => {
    const legacy = [assistant("e", "A"), tool("e#1")];
    const sync = [assistant("e", "AB", 0)];
    const merge = createSyncMessageMerger();
    const first = merge(legacy, sync);
    const second = merge(legacy, sync);
    expect(view(second)).toEqual(view(first));
    expect(new Set(ids(first)).size).toBe(ids(first).length);
    const inputIds = new Set([...legacy.map((message) => message.id), ...sync.map((message) => message.id)]);
    for (const id of ids(first)) {
      if (id === "e" || id === "e#1") continue;
      expect(inputIds.has(id)).toBe(false);
    }
  });
});

describe("空白、乱序与重复 merge", () => {
  // 纯空白尾文不得静默丢弃；不得生成空白合成消息。
  test("纯空白尾文合并到相邻已知段", () => {
    const merged = createSyncMessageMerger()([assistant("e", "A"), tool("t")], [assistant("e", "A ", 0)]);
    expect(view(merged)).toEqual(["e=A ", "tool_call:t"]);
    expect(body(merged)).toBe("A ");
  });

  // 乱序 legacy 无法推断工具边界：整条退化为新投影单条消息，正文只出现一次，工具不丢。
  test("乱序 legacy 安全降级且不产生重复正文", () => {
    const merged = createSyncMessageMerger()(
      [tool("t2"), assistant("e#2", "C"), tool("t1"), assistant("e", "A")],
      [assistant("e", "ABC", 0)],
    );
    expect(body(merged)).toBe("ABC");
    expect(body(merged).split("A")).toHaveLength(2);
    expect(merged.filter((message) => message.type === "tool_call").map((message) => message.id)).toEqual(["t2", "t1"]);
  });

  // 旧侧追平、再次落后时尾段必须出现/消失/再出现，且不重复。
  test("旧侧追平与再次落后时尾段幂等收敛", () => {
    const sync = [assistant("e", "ABC", 0)];
    const merge = createSyncMessageMerger();
    const behind = merge([assistant("e", "A"), tool("t")], sync);
    expect(view(behind)).toEqual(["e=A", "tool_call:t", "e#1=BC"]);
    const caughtUp = merge([assistant("e", "A"), tool("t"), assistant("e#1", "BC")], sync);
    expect(view(caughtUp)).toEqual(["e=A", "tool_call:t", "e#1=BC"]);
    const behindAgain = merge([assistant("e", "A"), tool("t")], sync);
    expect(view(behindAgain)).toEqual(["e=A", "tool_call:t", "e#1=BC"]);
    expect(body(behindAgain)).toBe("ABC");
  });

  // 真实投影不携带工具边界：content Doc 中的 tool_object 被镜像跳过，正文被压成一条。
  test("SyncContentProjectionHub 跳过 tool_object，证明结构边界不可得", () => {
    const content = new Y.Doc();
    const records = new Y.Array<Record<string, unknown>>();
    content.getMap("root").set("records", records);
    const encoder = new TextEncoder();
    records.push([
      {
        recordId: "r1",
        entryId: "turn:assistant",
        entryOrder: 1,
        contentSlot: "text",
        partIndex: 0,
        kind: "text",
        payload: encoder.encode("ai "),
      },
      {
        recordId: "r2",
        entryId: "turn:assistant",
        entryOrder: 1,
        contentSlot: "tool",
        partIndex: 1,
        kind: "tool_object",
        payload: encoder.encode(JSON.stringify({ toolCallId: "t" })),
      },
      {
        recordId: "r3",
        entryId: "turn:assistant",
        entryOrder: 1,
        contentSlot: "text",
        partIndex: 2,
        kind: "text",
        payload: encoder.encode("ai"),
      },
    ]);
    const hub = createSyncContentProjectionHub({ onProjection: () => {} });
    hub.applyUpdate({ docId: "sync/content/gen/0/nonce", generation: "gen", payload: Y.encodeStateAsUpdate(content) });
    const projection = hub.snapshot();
    expect(projection.messages).toHaveLength(1);
    expect(body(projection.messages)).toBe("ai ai");
    expect(projection.skippedRecords).toBe(1);
    hub.dispose();
    content.destroy();
  });
});

describe("缺口属性检查（200 轮 × 7 种缺段组合）", () => {
  // 任意缺段组合下，正文必须完整可见、工具顺序不变；这是 1400 次断言的仓库内可复现证据。
  test("任意缺段组合正文完整且工具顺序稳定", () => {
    let checks = 0;
    for (let round = 0; round < 200; round += 1) {
      const segments = [`s${round}a`, `s${round}b`, `s${round}c`];
      const full: StructuredMessage[] = [
        assistant("e", segments[0]!),
        tool("t1"),
        assistant("e#1", segments[1]!),
        tool("t2"),
        assistant("e#2", segments[2]!),
      ];
      const sync = [assistant("e", segments.join(""), 0)];
      for (let mask = 1; mask < 8; mask += 1) {
        const paged = full.filter((message) => {
          if (message.id === "e") return (mask & 1) === 0;
          if (message.id === "e#1") return (mask & 2) === 0;
          if (message.id === "e#2") return (mask & 4) === 0;
          return true;
        });
        const merged = createSyncMessageMerger()(paged, sync);
        expect(body(merged)).toBe(segments.join(""));
        expect(merged.filter((message) => message.type === "tool_call").map((message) => message.id)).toEqual([
          "t1",
          "t2",
        ]);
        expect(new Set(ids(merged)).size).toBe(ids(merged).length);
        checks += 1;
      }
    }
    expect(checks).toBe(1400);
  });
});
