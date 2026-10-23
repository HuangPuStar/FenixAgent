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

function plan(id: string): StructuredMessage {
  return { type: "plan", id, entries: [] };
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

describe("缺口定位：无标记时只处理单缺口，其余显式降级", () => {
  // 单缺中段（一个边界、一个工具）：缺失正文属于下一段的前缀，工具位置正确。
  test("单缺中段时正文前缀合并到工具之后的已知段", () => {
    const merged = createSyncMessageMerger()(
      [assistant("e", "A"), tool("t"), assistant("e#1", "C")],
      [assistant("e", "ABC", 0)],
    );
    expect(view(merged)).toEqual(["e=A", "tool_call:t", "e#1=BC"]);
    expect(body(merged)).toBe("ABC");
  });

  // 单缺首段（一个边界、一个工具）：缺失的 #0 必须排在工具之前。
  test("单缺首段时正文落在第一个工具之前", () => {
    const merged = createSyncMessageMerger()([tool("t1"), assistant("e#1", "B")], [assistant("e", "AB", 0)]);
    expect(view(merged)).toEqual(["e=A", "tool_call:t1", "e#1=B"]);
    expect(body(merged)).toBe("AB");
  });

  // 多缺段无法拆分：不得把 B、C 合并塞到第一个工具之后；整条降级，正文只出现一次。
  test("多缺段无法拆分时安全降级", () => {
    const degradations: Array<{ entryId: string; reason: string }> = [];
    const merged = createSyncMessageMerger(undefined, {
      onDegraded: (degradation) => degradations.push(degradation),
    })([assistant("e", "A"), tool("t1"), tool("t2"), assistant("e#2", "C")], [assistant("e", "ABC", 0)]);
    expect(ids(merged)).toEqual(["e", "t1", "t2"]);
    expect(textOf(merged[0]!)).toBe("ABC");
    expect(degradations).toContainEqual({ entryId: "e", reason: "boundary-count-mismatch" });
  });

  // 缺尾段且其后有工具：位置不可判定，必须降级而不是猜在第一个工具之后。
  test("缺尾段且其后有工具时安全降级", () => {
    const degradations: Array<{ entryId: string; reason: string }> = [];
    const merged = createSyncMessageMerger(undefined, {
      onDegraded: (degradation) => degradations.push(degradation),
    })([assistant("e", "A"), tool("t1"), tool("t2")], [assistant("e", "AB", 0)]);
    expect(ids(merged)).toEqual(["e", "t1", "t2"]);
    expect(textOf(merged[0]!)).toBe("AB");
    expect(degradations).toContainEqual({ entryId: "e", reason: "trailing-tools-without-markers" });
  });

  // 边界计数与工具数不一致：不得猜测，整条降级。
  test("工具数与分段边界数不一致时安全降级且正文只出现一次", () => {
    const merged = createSyncMessageMerger()(
      [assistant("e", "A"), tool("t1"), assistant("e#2", "C")],
      [assistant("e", "ABC", 0)],
    );
    expect(ids(merged)).toEqual(["e", "t1"]);
    expect(textOf(merged[0]!)).toBe("ABC");
  });

  // 重复子串有多种对齐方式：不得贪心拆到工具两侧，整条降级且正文只出现一次。
  test("重复子串无法唯一对齐时安全降级", () => {
    const degradations: Array<{ entryId: string; reason: string }> = [];
    const merged = createSyncMessageMerger(undefined, {
      onDegraded: (degradation) => degradations.push(degradation),
    })([assistant("e", "A"), tool("t1"), tool("t2"), assistant("e#1", "B")], [assistant("e", "AABB", 0)]);
    expect(body(merged)).toBe("AABB");
    expect(body(merged).split("A")).toHaveLength(3);
    expect(merged.filter((message) => message.type === "tool_call").map((message) => message.id)).toEqual(["t1", "t2"]);
    expect(degradations).toContainEqual({ entryId: "e", reason: "ambiguous-alignment" });
  });

  // 同一 entry + 原因只上报一次，避免流式每帧刷日志。
  test("降级回调每个 entry 与原因只上报一次", () => {
    const seen: string[] = [];
    const merge = createSyncMessageMerger(undefined, {
      onDegraded: (degradation) => seen.push(`${degradation.entryId}:${degradation.reason}`),
    });
    const legacy = [assistant("e", "A"), tool("t")];
    const sync = [assistant("e", "AB", 0)];
    merge(legacy, sync);
    merge(legacy, sync);
    expect(seen).toEqual(["e:trailing-tools-without-markers"]);
  });
});

describe("全局唯一 id 与 fallback 覆盖", () => {
  // fallback 不得复用被消费的 sync base id 覆盖同 id 用户消息。
  test("fallback 不得覆盖同 id 用户消息", () => {
    const merged = createSyncMessageMerger()(
      [user("e", "问"), assistant("e#2", "C"), tool("t")],
      [assistant("e", "ABC", 0)],
    );
    expect(ids(merged)).toEqual(["e", "e#1", "t"]);
    expect(merged[0]).toMatchObject({ type: "user_message", content: "问" });
    expect(textOf(merged[1]!)).toBe("ABC");
    expect(new Set(ids(merged)).size).toBe(ids(merged).length);
  });

  // fallback 不得覆盖同 id 工具。
  test("fallback 不得覆盖同 id 工具", () => {
    const merged = createSyncMessageMerger()([tool("e"), assistant("e#2", "C")], [assistant("e", "ABC", 0)]);
    expect(ids(merged)).toEqual(["e", "e#1"]);
    expect(merged[0]).toMatchObject({ type: "tool_call", id: "e" });
    expect(textOf(merged[1]!)).toBe("ABC");
    expect(new Set(ids(merged)).size).toBe(ids(merged).length);
  });

  // fallback 不得覆盖同 id plan。
  test("fallback 不得覆盖同 id plan", () => {
    const merged = createSyncMessageMerger()([plan("e"), assistant("e#2", "C"), tool("t")], [assistant("e", "ABC", 0)]);
    expect(ids(merged)).toEqual(["e", "e#1", "t"]);
    expect(merged[0]).toMatchObject({ type: "plan", id: "e" });
    expect(textOf(merged[1]!)).toBe("ABC");
    expect(new Set(ids(merged)).size).toBe(ids(merged).length);
  });

  // 降级 id 不得与另一条新投影 entry 冲突，正文 AB + XYZ 都可见。
  test("降级 id 不得与另一条新投影 entry 冲突", () => {
    const merged = createSyncMessageMerger()(
      [assistant("e", "A"), tool("t")],
      [assistant("e", "AB", 0), assistant("e#1", "XYZ", 0)],
    );
    expect(view(merged)).toEqual(["e=AB", "tool_call:t", "e#1=XYZ"]);
    expect(body(merged)).toBe("ABXYZ");
    expect(new Set(ids(merged)).size).toBe(ids(merged).length);
  });

  // 降级 id 不得与工具 id 冲突；工具与正文都保留。
  test("降级 id 不得与工具 id 冲突", () => {
    const merged = createSyncMessageMerger()([assistant("e", "A"), tool("e#1")], [assistant("e", "AB", 0)]);
    expect(view(merged)).toEqual(["e=AB", "tool_call:e#1"]);
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

  // 重复 merge 时降级 id 稳定，且不与输入中的任何消息 id 重复。
  test("重复 merge 时降级 id 稳定且不与输入 id 冲突", () => {
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
  test("旧侧追平与再次落后时前缀合并且不重复", () => {
    const sync = [assistant("e", "ABC", 0)];
    const merge = createSyncMessageMerger();
    const behind = merge([assistant("e", "A"), tool("t"), assistant("e#1", "C")], sync);
    expect(view(behind)).toEqual(["e=A", "tool_call:t", "e#1=BC"]);
    const caughtUp = merge([assistant("e", "A"), tool("t"), assistant("e#1", "BC")], sync);
    expect(view(caughtUp)).toEqual(["e=A", "tool_call:t", "e#1=BC"]);
    const behindAgain = merge([assistant("e", "A"), tool("t"), assistant("e#1", "C")], sync);
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

describe("有序工具边界标记（精确结构）", () => {
  /** 用真实 SyncContentProjectionHub 从 content Doc 记录派生投影；text / tool_boundary 交替。 */
  function project(parts: ReadonlyArray<string | { tool: string }>): StructuredMessage[] {
    const content = new Y.Doc();
    const records = new Y.Array<Record<string, unknown>>();
    content.getMap("root").set("records", records);
    const encoder = new TextEncoder();
    parts.forEach((part, index) => {
      const text = typeof part === "string";
      records.push([
        {
          recordId: `r${index}`,
          entryId: "turn:assistant",
          entryOrder: 1,
          contentSlot: text ? "text" : "boundary",
          partIndex: index,
          kind: text ? "text" : "tool_boundary",
          payload: encoder.encode(text ? part : JSON.stringify(part.tool)),
        },
      ]);
    });
    const hub = createSyncContentProjectionHub({ onProjection: () => {} });
    hub.applyUpdate({ docId: "sync/content/gen/0/nonce", generation: "gen", payload: Y.encodeStateAsUpdate(content) });
    const messages = hub.snapshot().messages;
    hub.dispose();
    content.destroy();
    return messages;
  }

  // 标记存在时多缺段可精确拆分：B 落 t1/t2 之间，C 落 t2/t3 之间。
  test("多缺段按标记精确落位", () => {
    const sync = project(["A", { tool: "t1" }, "B", { tool: "t2" }, "C", { tool: "t3" }, "D"]);
    expect(sync.map((message) => message.id)).toEqual([
      "turn:assistant",
      "turn:assistant#1",
      "turn:assistant#2",
      "turn:assistant#3",
    ]);
    const merged = createSyncMessageMerger()(
      [assistant("turn:assistant", "A"), tool("t1"), tool("t2"), tool("t3"), assistant("turn:assistant#3", "D")],
      sync,
    );
    expect(view(merged)).toEqual([
      "turn:assistant=A",
      "tool_call:t1",
      "turn:assistant#1=B",
      "tool_call:t2",
      "turn:assistant#2=C",
      "tool_call:t3",
      "turn:assistant#3=D",
    ]);
    expect(body(merged)).toBe("ABCD");
  });

  // 标记存在时缺首段 + 缺中段都能精确落位，不跨越工具。
  test("缺首段与缺中段按标记精确落位", () => {
    const sync = project(["A", { tool: "t1" }, "B", { tool: "t2" }, "C"]);
    const merged = createSyncMessageMerger()([tool("t1"), tool("t2"), assistant("turn:assistant#2", "C")], sync);
    expect(view(merged)).toEqual([
      "turn:assistant=A",
      "tool_call:t1",
      "turn:assistant#1=B",
      "tool_call:t2",
      "turn:assistant#2=C",
    ]);
    expect(body(merged)).toBe("ABC");
  });

  // 标记存在时缺尾段落在工具 run 之后（run 内的多个工具都属于该边界）。
  test("缺尾段按标记落在工具 run 之后", () => {
    const sync = project(["A", { tool: "t1" }, { tool: "t2" }, "B"]);
    const merged = createSyncMessageMerger()([assistant("turn:assistant", "A"), tool("t1"), tool("t2")], sync);
    expect(view(merged)).toEqual(["turn:assistant=A", "tool_call:t1", "tool_call:t2", "turn:assistant#1=B"]);
    expect(body(merged)).toBe("AB");
  });

  // 重复子串在标记存在时按真实段边界切分，不做字符串贪心。
  test("重复子串按标记精确切分", () => {
    const sync = project(["A", { tool: "t1" }, "AB", { tool: "t2" }, "B"]);
    const merged = createSyncMessageMerger()(
      [assistant("turn:assistant", "A"), tool("t1"), tool("t2"), assistant("turn:assistant#2", "B")],
      sync,
    );
    expect(view(merged)).toEqual([
      "turn:assistant=A",
      "tool_call:t1",
      "turn:assistant#1=AB",
      "tool_call:t2",
      "turn:assistant#2=B",
    ]);
    expect(body(merged)).toBe("AABB");
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
