// content Doc 的 reasoning 槽位只属于思考通道；放进正文会让实时回复混入分析文字（issue #37）。

import { expect, test } from "bun:test";
import * as Y from "yjs";
import { createSyncContentProjectionHub } from "../yjs/sync-doc-hub";
import { parseContentDoc } from "../yjs/sync-doc-parse";

const GENERATION = "gen_issue37";
const DOC_ID = `sync/content/${GENERATION}/1/issue37`;

interface RecordInput {
  readonly recordId: string;
  readonly entryId: string;
  readonly contentSlot: string | number;
  readonly kind?: "text" | "text_part" | "tool_boundary";
  readonly payload: Uint8Array;
}

function encoder(): TextEncoder {
  return new TextEncoder();
}

function contentDoc(records: readonly RecordInput[]): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => {
    const root = doc.getMap<unknown>("root");
    root.set("schemaVersion", 1);
    root.set("kind", "content");
    root.set("generation", GENERATION);
    root.set("blockIndex", 1);
    const list = new Y.Array<Record<string, unknown>>();
    root.set("records", list);
    list.push(
      records.map((record, index) => ({
        recordId: record.recordId,
        entryId: record.entryId,
        entryOrder: 1,
        contentSlot: record.contentSlot,
        partIndex: index,
        kind: record.kind ?? "text",
        payload: record.payload,
      })),
    );
  });
  return doc;
}

// reasoning 记录与正文记录同处一个 content Doc 时，正文投影不得包含思考文本。
test("正文投影排除 reasoning 槽位", () => {
  const doc = contentDoc([
    {
      recordId: "rec_reasoning",
      entryId: "turn-1:assistant",
      contentSlot: "reasoning",
      payload: encoder().encode("The user says 广州新闻，我需要检索新闻。"),
    },
    {
      recordId: "rec_text",
      entryId: "turn-1:assistant",
      contentSlot: "text",
      payload: encoder().encode("这是广州新闻的正式回答。"),
    },
  ]);

  let projection = createSyncContentProjectionHub({ onProjection: (next) => (projection = next) });
  projection.applyUpdate({ docId: DOC_ID, generation: GENERATION, payload: Y.encodeStateAsUpdate(doc) });
  const messages = projection.snapshot().messages;

  expect(messages).toHaveLength(1);
  const message = messages[0];
  if (message?.type !== "assistant_message") throw new Error("expected assistant message");
  expect(message.chunks).toEqual([{ type: "message", text: "这是广州新闻的正式回答。" }]);

  projection.dispose();
  doc.destroy();
});

// 思考跨工具时仍按工具边界切分正文：reasoning 不进入任何正文段，也不干扰边界序号。
test("思考跨工具时正文分段与工具边界保持原序", () => {
  const doc = contentDoc([
    {
      recordId: "rec_r1",
      entryId: "turn-1:assistant",
      contentSlot: "reasoning",
      payload: encoder().encode("先分析。"),
    },
    {
      recordId: "rec_t1",
      entryId: "turn-1:assistant",
      contentSlot: "text",
      payload: encoder().encode("工具前正文。"),
    },
    {
      recordId: "rec_b1",
      entryId: "turn-1:assistant",
      contentSlot: "boundary",
      kind: "tool_boundary",
      payload: encoder().encode(JSON.stringify({ toolCallId: "tool-1", ordinal: 0 })),
    },
    {
      recordId: "rec_r2",
      entryId: "turn-1:assistant",
      contentSlot: "reasoning",
      payload: encoder().encode("再分析。"),
    },
    {
      recordId: "rec_t2",
      entryId: "turn-1:assistant",
      contentSlot: "text",
      payload: encoder().encode("工具后正文。"),
    },
  ]);

  const parsed = parseContentDoc(doc);
  const entry = parsed.contribution.get("turn-1:assistant");
  if (entry === undefined) throw new Error("expected entry contribution");

  expect(entry.parts.map((part) => [part.kind, part.text])).toEqual([
    ["text", "工具前正文。"],
    ["boundary", ""],
    ["text", "工具后正文。"],
  ]);

  doc.destroy();
});

// 历史导入的正文是数字槽位 0，新增过滤不能误伤历史记录。
test("历史 text_part 的数字槽位仍作为正文", () => {
  const doc = contentDoc([
    {
      recordId: "rec_history",
      entryId: "turn-1:assistant",
      contentSlot: 0,
      kind: "text_part",
      payload: encoder().encode(JSON.stringify("历史正文。")),
    },
  ]);

  const parsed = parseContentDoc(doc);
  const entry = parsed.contribution.get("turn-1:assistant");
  if (entry === undefined) throw new Error("expected entry contribution");

  expect(entry.parts.map((part) => part.text)).toEqual(["历史正文。"]);

  doc.destroy();
});
