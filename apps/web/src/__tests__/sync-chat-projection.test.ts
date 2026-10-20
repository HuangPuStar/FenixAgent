// apps/web/src/__tests__/sync-chat-projection.test.ts
// 新同步协议 content Doc → 只读 StructuredMessage 投影的回归。
//
// 记录形状取自 sync/live/live-writer.ts 与 sync/history/block-builder.ts 的写入契约：
// root.records 是扁平对象数组（recordId/entryId/entryOrder/contentSlot/partIndex/kind/payload）。
// 这里直接构造等价 Y.Doc 字节，不经过后端，也不改旧 Chat Doc。

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import {
  createSyncContentProjectionHub,
  emptySyncChatProjection,
  parseContentDocId,
  type SyncChatProjection,
} from "../../../../packages/agent-runtime/web/yjs/sync-doc-hub";

const GENERATION = "gen_projection01";

interface RecordSpec {
  recordId?: string;
  entryId: string;
  entryOrder?: number;
  contentSlot?: string | number;
  partIndex?: number;
  kind: string;
  payload: Uint8Array | string;
}

function contentDocUpdate(records: readonly RecordSpec[], blockIndex: number): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => {
    const root = doc.getMap<unknown>("root");
    root.set("schemaVersion", 1);
    root.set("kind", "content");
    root.set("generation", GENERATION);
    root.set("blockIndex", blockIndex);
    const array = new Y.Array<Record<string, unknown>>();
    root.set("records", array);
    array.push(
      records.map((record, index) => ({
        recordId: record.recordId ?? `rec_${blockIndex}_${index}`,
        entryId: record.entryId,
        entryOrder: record.entryOrder ?? 0,
        contentSlot: record.contentSlot ?? "text",
        partIndex: record.partIndex ?? 0,
        kind: record.kind,
        payload: typeof record.payload === "string" ? new TextEncoder().encode(record.payload) : record.payload,
      })),
    );
  });
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return update;
}

function contentDocId(blockIndex: number): string {
  return `sync/content/${GENERATION}/${blockIndex}/nonce_${blockIndex}`;
}

let appendSequence = 0;

/** 向同一个 Y.Doc 追加记录并只编码增量（模拟 live writer 的连续提交）。 */
function appendContentUpdate(doc: Y.Doc, records: readonly RecordSpec[], blockIndex: number): Uint8Array {
  const before = Y.encodeStateVector(doc);
  doc.transact(() => {
    const root = doc.getMap<unknown>("root");
    if (!(root.get("records") instanceof Y.Array)) {
      root.set("schemaVersion", 1);
      root.set("kind", "content");
      root.set("generation", GENERATION);
      root.set("blockIndex", blockIndex);
      root.set("records", new Y.Array<Record<string, unknown>>());
    }
    const array = root.get("records") as Y.Array<Record<string, unknown>>;
    array.push(
      records.map((record) => ({
        recordId: `rec_append_${appendSequence++}`,
        entryId: record.entryId,
        entryOrder: record.entryOrder ?? 0,
        contentSlot: record.contentSlot ?? "text",
        partIndex: record.partIndex ?? 0,
        kind: record.kind,
        payload: typeof record.payload === "string" ? new TextEncoder().encode(record.payload) : record.payload,
      })),
    );
  });
  return Y.encodeStateAsUpdate(doc, before);
}

function descriptor(completedAt: number, entityId: string): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      entityId,
      kind: "permission",
      contentRef: entityId,
      digest: "sha256:x",
      byteLength: 1,
      completedAt,
    }),
  );
}

async function flushProjection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createHub(): { hub: ReturnType<typeof createSyncContentProjectionHub>; latest: () => SyncChatProjection } {
  let latest = emptySyncChatProjection();
  const hub = createSyncContentProjectionHub({
    onProjection: (projection) => {
      latest = projection;
    },
  });
  hub.reset(GENERATION);
  return { hub, latest: () => latest };
}

describe("sync content Doc 只读投影", () => {
  // assistant 文本按块/记录顺序拼接，输出与旧 Chat UI 的 assistant_message 同形。
  test("文本记录投影为 assistant_message，跨块顺序稳定", async () => {
    const { hub, latest } = createHub();
    const first = contentDocUpdate([{ entryId: "turn_1:assistant", kind: "text", payload: "hello " }], 1);
    const second = contentDocUpdate([{ entryId: "turn_1:assistant", kind: "text", payload: "world" }], 2);
    expect(hub.applyUpdate({ docId: contentDocId(1), generation: GENERATION, payload: first })).toBe(true);
    expect(hub.applyUpdate({ docId: contentDocId(2), generation: GENERATION, payload: second })).toBe(true);
    await flushProjection();

    expect(latest().messages).toEqual([
      {
        type: "assistant_message",
        id: "turn_1:assistant",
        chunks: [{ type: "message", text: "hello world" }],
        seq: 0,
        ts: 0,
      },
    ]);
  });

  // 用户消息按 entryId 的 `:user` 后缀区分，content 与旧 UI 的 user_message 字段一致。
  test("user entry 投影为 user_message", async () => {
    const { hub, latest } = createHub();
    hub.applyUpdate({
      docId: contentDocId(1),
      generation: GENERATION,
      payload: contentDocUpdate([{ entryId: "turn_1:user", kind: "text", payload: "hi" }], 1),
    });
    await flushProjection();
    expect(latest().messages).toEqual([{ type: "user_message", id: "turn_1:user", content: "hi", seq: 0, ts: 0 }]);
  });

  // final descriptor 只提供完成时间，不把描述符 JSON 当正文；只有描述符的 entry 不产生消息。
  test("final descriptor 设置 ts 且不伪造正文", async () => {
    const { hub, latest } = createHub();
    hub.applyUpdate({
      docId: contentDocId(1),
      generation: GENERATION,
      payload: contentDocUpdate(
        [
          { entryId: "turn_2:assistant", kind: "text", payload: "done" },
          {
            entryId: "turn_2:assistant",
            kind: "final",
            contentSlot: "final",
            payload: descriptor(1700000000000, "perm_1"),
          },
          { entryId: "perm_1", kind: "final", contentSlot: "final", payload: descriptor(1700000000001, "perm_1") },
        ],
        1,
      ),
    });
    await flushProjection();
    expect(latest().messages).toEqual([
      {
        type: "assistant_message",
        id: "turn_2:assistant",
        chunks: [{ type: "message", text: "done" }],
        seq: 0,
        ts: 1700000000000,
      },
    ]);
  });

  // 同一 update 重复应用不得产生重复消息：镜像按 recordId 去重，Yjs 合并本身也幂等。
  test("重复 apply 同一份 update 不重复出消息", async () => {
    const { hub, latest } = createHub();
    const update = contentDocUpdate([{ entryId: "turn_3:assistant", kind: "text", payload: "once" }], 1);
    hub.applyUpdate({ docId: contentDocId(1), generation: GENERATION, payload: update });
    hub.applyUpdate({ docId: contentDocId(1), generation: GENERATION, payload: update });
    await flushProjection();
    expect(latest().messages).toHaveLength(1);
    expect(latest().messages[0]).toMatchObject({ type: "assistant_message" });
  });

  // 内容未变的 entry 复用同一消息对象，避免每个增量都让整棵消息树失去 memo 稳定性。
  test("新增 entry 不重建已存在消息的引用", async () => {
    const { hub, latest } = createHub();
    hub.applyUpdate({
      docId: contentDocId(1),
      generation: GENERATION,
      payload: contentDocUpdate([{ entryId: "turn_7:assistant", kind: "text", payload: "first" }], 1),
    });
    await flushProjection();
    const firstMessage = latest().messages[0];

    hub.applyUpdate({
      docId: contentDocId(2),
      generation: GENERATION,
      payload: contentDocUpdate([{ entryId: "turn_8:assistant", kind: "text", payload: "second" }], 2),
    });
    await flushProjection();
    expect(latest().messages).toHaveLength(2);
    expect(latest().messages[0]).toBe(firstMessage);
  });

  // 无法映射的历史对象/工具对象只计入 skipped，不猜正文；坏字节也不抛出。
  test("history_object/tool_object 与坏 payload 计入 skipped 而不伪造", async () => {
    const { hub, latest } = createHub();
    hub.applyUpdate({
      docId: contentDocId(1),
      generation: GENERATION,
      payload: contentDocUpdate(
        [
          { entryId: "turn_4:assistant", kind: "history_object", payload: '{"text":"ignored"}' },
          { entryId: "tool_1", kind: "tool_object", payload: "{}" },
          { entryId: "turn_4:assistant", kind: "text", payload: new Uint8Array([0xff, 0xfe]) },
          { entryId: "turn_4:assistant", kind: "text", payload: "kept" },
        ],
        1,
      ),
    });
    await flushProjection();
    expect(latest().messages).toHaveLength(1);
    expect(latest().skippedRecords).toBe(3);
    expect(latest().recordCount).toBe(1);
  });

  // 历史导入的 `text_part` 是保真 JSON 字符串：按 JSON 解码成正文，坏 JSON 只计入 skipped。
  test("text_part 按保真 JSON 解码为正文，坏 JSON 计入 skipped", async () => {
    const { hub, latest } = createHub();
    hub.applyUpdate({
      docId: contentDocId(1),
      generation: GENERATION,
      payload: contentDocUpdate(
        [
          { entryId: "turn_5:assistant", kind: "text_part", payload: JSON.stringify("历史正文") },
          { entryId: "turn_6:assistant", kind: "text_part", payload: "{not json" },
        ],
        1,
      ),
    });
    await flushProjection();
    expect(latest().messages).toHaveLength(1);
    expect(latest().messages[0]).toMatchObject({
      type: "assistant_message",
      id: "turn_5:assistant",
      chunks: [{ type: "message", text: "历史正文" }],
    });
    expect(latest().skippedRecords).toBe(1);
    expect(latest().recordCount).toBe(1);
  });

  // 同一 Doc 追加记录时只失效被改动的 entry：其他消息对象必须保持引用，React.memo 才能跳过。
  test("同一 Doc 追加记录不重建未变 entry 的消息对象", async () => {
    const { hub, latest } = createHub();
    const doc = new Y.Doc();
    const docId = contentDocId(1);
    hub.applyUpdate({
      docId,
      generation: GENERATION,
      payload: appendContentUpdate(
        doc,
        [
          { entryId: "turn_a:assistant", kind: "text", payload: "first" },
          { entryId: "turn_b:assistant", kind: "text", payload: "stable" },
        ],
        1,
      ),
    });
    await flushProjection();
    const before = latest().messages;
    expect(before.map((message) => message.id)).toEqual(["turn_a:assistant", "turn_b:assistant"]);

    hub.applyUpdate({
      docId,
      generation: GENERATION,
      payload: appendContentUpdate(
        doc,
        [
          { entryId: "turn_a:assistant", kind: "text", payload: " second" },
          { entryId: "turn_c:assistant", kind: "text", payload: "new" },
        ],
        1,
      ),
    });
    await flushProjection();
    const after = latest().messages;
    expect(after.map((message) => message.id)).toEqual(["turn_a:assistant", "turn_b:assistant", "turn_c:assistant"]);
    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  // reset 必须清空全部镜像与消息（换代会话/重连时由 session 调用）。
  test("reset 清空消息并切换代次过滤", async () => {
    const { hub, latest } = createHub();
    hub.applyUpdate({
      docId: contentDocId(1),
      generation: GENERATION,
      payload: contentDocUpdate([{ entryId: "turn_5:assistant", kind: "text", payload: "old" }], 1),
    });
    await flushProjection();
    expect(latest().messages).toHaveLength(1);

    hub.reset(GENERATION);
    await flushProjection();
    expect(latest().messages).toEqual([]);

    const foreign = contentDocUpdate([{ entryId: "turn_6:assistant", kind: "text", payload: "foreign" }], 1);
    const applied = hub.applyUpdate({ docId: "sync/content/gen_other/1/n", generation: "gen_other", payload: foreign });
    expect(applied).toBe(false);
  });

  // docId 谱系解析拒绝非 content 与非法块号，防止把 runtime/control Doc 混入消息投影。
  test("parseContentDocId 只接受 content 谱系", () => {
    expect(parseContentDocId(contentDocId(3))).toEqual({ generation: GENERATION, blockIndex: 3 });
    expect(parseContentDocId(`sync/runtime/${GENERATION}/0/n`)).toBeNull();
    expect(parseContentDocId(`sync/content/${GENERATION}/01/n`)).toBeNull();
    expect(parseContentDocId("not-a-doc-id")).toBeNull();
  });

  // 单个内容块也可能包含大量短消息：投影默认只给最近 600 条，显式扩大后才揭示更早条目。
  test("投影窗口默认 600 条，扩大后揭示隐藏条目", () => {
    const hub = createSyncContentProjectionHub({ onProjection: () => {} });
    hub.reset(GENERATION);
    const records = Array.from({ length: 700 }, (_, index) => ({
      entryId: `window_${index}:assistant`,
      entryOrder: index,
      kind: "text",
      payload: `window ${index}`,
    }));
    hub.applyUpdate({ docId: contentDocId(1), generation: GENERATION, payload: contentDocUpdate(records, 1) });
    const first = hub.snapshot();
    expect(first.messages).toHaveLength(600);
    expect(first.hiddenMessageCount).toBe(100);
    hub.growWindow(100);
    const grown = hub.snapshot();
    expect(grown.messages).toHaveLength(700);
    expect(grown.hiddenMessageCount).toBe(0);
  });
});
