import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import * as Y from "yjs";
import { createSyncMessageMerger } from "../hooks/sync-chat-messages";
import { createSyncContentProjectionHub } from "../yjs/sync-doc-hub";

type Assistant = Extract<StructuredMessage, { type: "assistant_message" }>;
type Part = string | { tool: string; ordinal: number };
const assistant = (id: string, text: string): Assistant => ({
  type: "assistant_message",
  id,
  chunks: [{ type: "message", text }],
  ts: 10000,
  seq: 1,
});
const tool = (id: string): StructuredMessage => ({
  type: "tool_call",
  id,
  title: id,
  status: "complete",
  content: [],
});
function project(entries: ReadonlyArray<{ id: string; parts: readonly Part[] }>): StructuredMessage[] {
  const doc = new Y.Doc();
  const records = new Y.Array<Record<string, unknown>>();
  doc.getMap("root").set("records", records);
  for (const [entryOrder, entry] of entries.entries()) {
    records.push(
      entry.parts.map((part, index) => ({
        recordId: `${entry.id}:${index}`,
        entryId: entry.id,
        entryOrder,
        contentSlot: "text",
        partIndex: index,
        kind: typeof part === "string" ? "text" : "tool_boundary",
        payload: new TextEncoder().encode(
          typeof part === "string"
            ? part
            : JSON.stringify({
                toolCallId: part.tool,
                ordinal: part.ordinal,
              }),
        ),
      })),
    );
  }
  const hub = createSyncContentProjectionHub({ onProjection: () => {} });
  hub.applyUpdate({ docId: "sync/content/gen/0/test", generation: "gen", payload: Y.encodeStateAsUpdate(doc) });
  const result = [...hub.snapshot().messages];
  hub.dispose();
  doc.destroy();
  return result;
}
function text(message: StructuredMessage): string {
  return message.type === "assistant_message"
    ? message.chunks
        .filter((chunk) => chunk.type === "message")
        .map((chunk) => chunk.text)
        .join("")
    : "";
}
function visible(messages: readonly StructuredMessage[]): string[] {
  return messages.map((message) =>
    message.type === "tool_call"
      ? `tool:${message.title}`
      : message.type === "assistant_message"
        ? text(message)
        : message.type,
  );
}
function merge(legacy: StructuredMessage[], sync: StructuredMessage[]) {
  const degraded: Array<{ entryId: string; reason: string }> = [];
  const merger = createSyncMessageMerger(undefined, { onDegraded: (value) => degraded.push(value) });
  const result = merger(legacy, sync);
  return {
    result,
    degraded,
    again: () =>
      merger(
        legacy.map((message) => ({ ...message })),
        sync,
      ),
  };
}

describe("第六轮：工具边界与降级保真", () => {
  // 文本 ordinal 0 也可能位于工具之后，不能无条件挪到第一个工具之前。
  test("R6 ordinal0 位于非空边界工具之后", () => {
    const sync = project([{ id: "e", parts: [{ tool: "t1", ordinal: 0 }, "A", { tool: "t2", ordinal: 1 }, "B"] }]);
    const { result, degraded } = merge([tool("t1"), tool("t2"), assistant("e#1", "B")], sync);
    expect(visible(result)).toEqual(["tool:t1", "A", "tool:t2", "B"]);
    expect(result.map(text).join("")).toBe("AB");
    expect(degraded).toEqual([]);
  });

  // 相邻 entry 的工具同名时必须匹配本 entry 的 occurrence，通用合并不得吞掉工具。
  test("R6 跨 entry 同名工具完整保留并正确落位", () => {
    const sync = project([
      { id: "a", parts: ["A", { tool: "same", ordinal: 0 }, "B"] },
      { id: "b", parts: [{ tool: "same", ordinal: 0 }, "C", { tool: "tail", ordinal: 1 }, "D"] },
    ]);
    const check = merge(
      [assistant("a", "A"), tool("same"), assistant("a#1", "B"), tool("same"), tool("tail"), assistant("b#1", "D")],
      sync,
    );
    expect(visible(check.result)).toEqual(["A", "tool:same", "B", "tool:same", "C", "tool:tail", "D"]);
    expect(check.result.map(text).join("")).toBe("ABCD");
    expect(new Set(check.result.map((message) => message.id)).size).toBe(check.result.length);
    expect(visible(check.again())).toEqual(visible(check.result));
    expect(check.degraded).toEqual([]);
  });

  // 同一工具 run 内 toolCallId 复用时，段前边界必须指向第二个 occurrence。
  test("R6 同 run 同名工具不去重且 run 尾定位正确", () => {
    const sync = project([
      {
        id: "e",
        parts: [
          "A",
          { tool: "same", ordinal: 0 },
          { tool: "same", ordinal: 1 },
          "B",
          { tool: "tail", ordinal: 2 },
          "C",
        ],
      },
    ]);
    const check = merge([assistant("e", "A"), tool("same"), tool("same"), tool("tail"), assistant("e#2", "C")], sync);
    expect(visible(check.result)).toEqual(["A", "tool:same", "tool:same", "B", "tool:tail", "C"]);
    expect(check.result.map(text).join("")).toBe("ABC");
    expect(new Set(check.result.map((message) => message.id)).size).toBe(check.result.length);
    expect(visible(check.again())).toEqual(visible(check.result));
    expect(check.degraded).toEqual([]);
  });

  // 旧侧尾段 BC 超前，新侧缺 t2 marker：不能把 C 追加两次，也不能丢旧侧多出的 B。
  test("R6 部分 marker 缺失与旧侧超前 BC 显式降级", () => {
    const sync = project([{ id: "e", parts: ["A", { tool: "t1", ordinal: 0 }, "BC"] }]);
    const { result, degraded } = merge(
      [assistant("e", "A"), tool("t1"), assistant("e#1", "B"), tool("t2"), assistant("e#2", "BC")],
      sync,
    );
    expect(result.map(text).join("")).toBe("ABBC");
    expect(visible(result)).toEqual(["ABBC", "tool:t1", "tool:t2"]);
    expect(degraded).toEqual([{ entryId: "e", reason: "incomplete-markers" }]);
  });

  // 即使正文没有增量，只要旧侧边界超前也不能宣称标记完整。
  test("R6 无新增正文的缺失尾 marker 仍降级", () => {
    const sync = project([{ id: "e", parts: ["A", { tool: "t1", ordinal: 0 }, "B"] }]);
    const { result, degraded } = merge(
      [assistant("e", "A"), tool("t1"), assistant("e#1", "B"), tool("t2"), assistant("e#2", "C")],
      sync,
    );
    expect(result.map(text).join("")).toBe("ABC");
    expect(degraded).toEqual([{ entryId: "e", reason: "incomplete-markers" }]);
  });

  // fallback 必须保留 thought 与正文的交错、两条错误，以及工具/用户/plan 的原始位置。
  test("R6 fallback 保留全部 chunk 与多个 error", () => {
    const first = assistant("e", "A");
    first.chunks.push({ type: "thought", text: "THINK1" }, { type: "message", text: "B" });
    first.error = { type: "AGENT_RUNTIME.PROMPT_REJECTED", id: "err1", message: "ERR1" };
    const last = assistant("e#2", "D");
    last.chunks.unshift({ type: "thought", text: "THINK2" });
    last.error = { type: "AGENT_RUNTIME.PROMPT_REJECTED", id: "err2", message: "ERR2" };
    const { result, degraded } = merge(
      [
        { type: "user_message", id: "u", content: "问", ts: 10000 },
        first,
        tool("t1"),
        { type: "plan", id: "p", entries: [] },
        tool("t2"),
        last,
      ],
      [assistant("e", "ABCD")],
    );
    expect(result.map(text).join("")).toBe("ABCD");
    const chunks = result.flatMap((message) => (message.type === "assistant_message" ? message.chunks : []));
    expect(chunks).toEqual([
      { type: "message", text: "A" },
      { type: "thought", text: "THINK1" },
      { type: "message", text: "B" },
      { type: "thought", text: "THINK2" },
      { type: "message", text: "CD" },
    ]);
    expect(
      result
        .flatMap((message) => (message.type === "assistant_message" ? (message.error ? [message.error] : []) : []))
        .map((error) => error.id),
    ).toEqual(["err1", "err2"]);
    expect(visible(result)).toEqual(["user_message", "AB", "tool:t1", "plan", "tool:t2", "CD"]);
    expect(degraded).toEqual([{ entryId: "e", reason: "boundary-count-mismatch" }]);
  });

  // 属性模式同时覆盖工具开头、重复 id、连续 run 与缺段；无锚点仅承诺无损及显式降级。
  test("R6 标记存在加重复工具 id 与 run 属性检查", () => {
    let checks = 0;
    for (let round = 0; round < 50; round += 1) {
      const segments = [`A${round}`, `B${round}`, `C${round}`];
      const parts: Part[] = [
        { tool: "same", ordinal: 0 },
        segments[0]!,
        { tool: "same", ordinal: 1 },
        { tool: "same", ordinal: 2 },
        segments[1]!,
        { tool: "tail", ordinal: 3 },
        segments[2]!,
      ];
      const sync = project([{ id: "e", parts }]);
      for (let mask = 1; mask < 8; mask += 1) {
        const legacy = [
          tool("same"),
          ...(mask & 1 ? [] : [assistant("e", segments[0]!)]),
          tool("same"),
          tool("same"),
          ...(mask & 2 ? [] : [assistant("e#1", segments[1]!)]),
          tool("tail"),
          ...(mask & 4 ? [] : [assistant("e#2", segments[2]!)]),
        ];
        const { result, degraded } = merge(legacy, sync);
        expect(result.map(text).join("")).toBe(segments.join(""));
        expect(result.filter((message) => message.type === "tool_call").map((message) => message.title)).toEqual([
          "same",
          "same",
          "same",
          "tail",
        ]);
        if (mask !== 7) {
          expect(visible(result)).toEqual([
            "tool:same",
            segments[0]!,
            "tool:same",
            "tool:same",
            segments[1]!,
            "tool:tail",
            segments[2]!,
          ]);
          expect(degraded).toEqual([]);
        } else expect(degraded).toContainEqual({ entryId: "e", reason: "missing-text-anchor" });
        checks += 1;
      }
    }
    expect(checks).toBe(350);
  });
});
