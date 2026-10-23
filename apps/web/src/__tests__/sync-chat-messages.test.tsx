import { describe, expect, test } from "bun:test";
import type { NormalizedEvent, StructuredMessage } from "@fenix/chat-channel";
import { applyNormalizedEvent, createChatDoc, createSessionDoc } from "@fenix/chat-channel/server";
import { AssistantBubble, UserBubble } from "@fenix/ui-components/chat/view/MessageBubble";
import {
  chatDocEntriesToStructuredMessages,
  structuredToThreadEntries,
} from "@fenix/web-runtime/chat/structured-to-thread";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import * as Y from "yjs";
import { createSyncMessageMerger } from "../../../../packages/agent-runtime/web/hooks/sync-chat-messages";
import { createSyncContentProjectionHub } from "../../../../packages/agent-runtime/web/yjs/sync-doc-hub";

function user(id: string, content: string, ts = 10000): StructuredMessage {
  return { type: "user_message", id, content, ts, seq: 0 };
}
function textOf(message: StructuredMessage): string {
  return message.type === "assistant_message"
    ? message.chunks.map((chunk) => (chunk.type === "message" ? chunk.text : "")).join("")
    : "";
}

function assistant(id: string, text: string, ts = 10000): StructuredMessage {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], ts, seq: 1 };
}

function tool(id: string): StructuredMessage {
  return { type: "tool_call", id, title: "Read", status: "complete", content: [] };
}

/** 统计 chunks 读取次数：用于证明模糊配对不再对每个 sync 消息线性扫描全部 legacy。 */
function countedAssistant(id: string, text: string, counter: { reads: number }): StructuredMessage {
  const message = { type: "assistant_message", id, ts: 0, seq: 0 } as StructuredMessage;
  Object.defineProperty(message, "chunks", {
    enumerable: true,
    get() {
      counter.reads += 1;
      return [{ type: "message", text }];
    },
  });
  return message;
}

async function renderMessages(messages: StructuredMessage[]): Promise<string> {
  const elements = structuredToThreadEntries(messages).map((entry) => {
    if (entry.type === "user_message") return createElement(UserBubble, { key: entry.id, entry });
    if (entry.type === "assistant_message") return createElement(AssistantBubble, { key: entry.id, entry });
    return null;
  });
  const i18n = createInstance();
  await i18n.init({ lng: "zh", resources: {}, initAsync: false });
  const stream = await renderToReadableStream(
    createElement(I18nextProvider, { i18n }, createElement("div", null, elements)),
  );
  await stream.allReady;
  return new Response(stream).text();
}

describe("新旧消息合并视图", () => {
  // 工具把旧助手正文切成 entryId / entryId#1 时，必须保留完整旧结构；新投影的合并文本不得顶掉最终答案（B02）。
  test("工具分段 entry 保留最终答案与顺序", () => {
    const thoughtAndText: StructuredMessage = {
      type: "assistant_message",
      id: "entry-1",
      chunks: [
        { type: "thought", text: "思考" },
        { type: "message", text: "前文" },
      ],
      seq: 0,
      ts: 10000,
    };
    const tool: StructuredMessage = {
      type: "tool_call",
      id: "tool-1",
      title: "Read",
      status: "complete",
      content: [],
    };
    const finalAnswer = assistant("entry-1#1", "最终答案", 10000);
    const combined = assistant("entry-1", "前文最终答案", 10000);
    const merged = createSyncMessageMerger()([thoughtAndText, tool, finalAnswer], [combined]);
    expect(merged.map((message) => message.id)).toEqual(["entry-1", "tool-1", "entry-1#1"]);
    expect(merged.at(-1)).toMatchObject({ id: "entry-1#1" });
  });

  // 流式中间态：工具已到、工具后的正文尚未在旧侧成段时，新投影多出的尾文必须排在工具之后，
  // 既不能前移到工具之前（"ai ai tools"），也不能因为旧侧未追平而静默隐藏（对抗验证 M01/M08）。
  test("工具后正文未成段时新投影尾文排在工具之后且不丢失", () => {
    const chat = createChatDoc("rcs-stream-order", null).ydoc;
    const session = createSessionDoc("rcs-stream-order", null).ydoc;
    const pair = { chat, session };
    const event = (
      type: NormalizedEvent["type"],
      update: Record<string, unknown> = {},
      turnId?: string,
    ): NormalizedEvent =>
      ({ type, update, content: (update.content as Record<string, unknown>) ?? null, turnId }) as NormalizedEvent;

    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "问" } }, "turn-stream"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "ai " } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "tool-s", title: "Read" }));

    // 中间态：旧路径只有首段 + 工具；新投影已包含工具后的正文。尾文必须以独立段排在工具之后。
    const merger = createSyncMessageMerger();
    const mid = merger(chatDocEntriesToStructuredMessages(chat), [assistant("turn-stream:assistant", "ai ai", 0)]);
    expect(mid.map((message) => message.id)).toEqual([
      "turn-stream:user",
      "turn-stream:assistant",
      "tool-s",
      "turn-stream:assistant#1",
    ]);
    expect(textOf(mid[1]!)).toBe("ai ");
    expect(textOf(mid[3]!)).toBe("ai");
    expect(mid.map((message) => textOf(message)).join("")).toBe("ai ai");

    // 旧路径补齐第二段：沿用同一 id 恢复为权威分段，不重复、不新增合成段。
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "ai" } }));
    const done = merger(chatDocEntriesToStructuredMessages(chat), [assistant("turn-stream:assistant", "ai ai", 0)]);
    expect(done.map((message) => message.id)).toEqual([
      "turn-stream:user",
      "turn-stream:assistant",
      "tool-s",
      "turn-stream:assistant#1",
    ]);
    expect(done.map((message) => textOf(message))).toEqual(["", "ai ", "", "ai"]);
  });

  // 对抗验证 M07：分页缺中段但保留工具与尾段时，新投影中的中段正文必须可见，不能显示成 AC。
  test("分页缺中段且保留工具时新投影中段正文不得丢失", () => {
    const chat = createChatDoc("rcs-page-middle", null).ydoc;
    const session = createSessionDoc("rcs-page-middle", null).ydoc;
    const pair = { chat, session };
    const event = (
      type: NormalizedEvent["type"],
      update: Record<string, unknown> = {},
      turnId?: string,
    ): NormalizedEvent =>
      ({ type, update, content: (update.content as Record<string, unknown>) ?? null, turnId }) as NormalizedEvent;

    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "问" } }, "turn-page"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "A" } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t1", title: "Read" }));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "B" } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "t2", title: "Grep" }));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "C" } }));

    // 分页只缺中段 #1（B），工具与尾段 #2（C）保留。
    const full = chatDocEntriesToStructuredMessages(chat);
    const paged = full.filter((message) => message.id !== "turn-page:assistant#1");
    const merged = createSyncMessageMerger()(paged, [assistant("turn-page:assistant", "ABC", 0)]);

    expect(merged.map((message) => message.id)).toEqual([
      "turn-page:user",
      "turn-page:assistant",
      "t1",
      "t2",
      "turn-page:assistant#2",
    ]);
    // 无法判定的中段并入紧随其后的已知段（C → BC），保证正文完整且文本顺序 A→B→C。
    expect(textOf(merged[4]!)).toBe("BC");
    expect(merged.map((message) => textOf(message)).join("")).toBe("ABC");
  });

  // 真实投影链路：旧侧由 applyNormalizedEvent 派生，新侧由 SyncContentProjectionHub 从 content Doc 派生，
  // 不手写 sync 消息；中间态尾文排在工具之后，旧侧追平后沿用同一分段 id 且不重复。
  test("真实投影中间态尾文排在工具后且追平后不重复", () => {
    const chat = createChatDoc("rcs-hub-order", null).ydoc;
    const session = createSessionDoc("rcs-hub-order", null).ydoc;
    const pair = { chat, session };
    const event = (
      type: NormalizedEvent["type"],
      update: Record<string, unknown> = {},
      turnId?: string,
    ): NormalizedEvent =>
      ({ type, update, content: (update.content as Record<string, unknown>) ?? null, turnId }) as NormalizedEvent;

    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "问" } }, "turn-hub"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "ai " } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "tool-h", title: "Read" }));

    const content = new Y.Doc();
    const records = new Y.Array<Record<string, unknown>>();
    content.getMap("root").set("records", records);
    const encoder = new TextEncoder();
    records.push([
      {
        recordId: "r1",
        entryId: "turn-hub:assistant",
        entryOrder: 1,
        contentSlot: "text",
        partIndex: 0,
        kind: "text",
        payload: encoder.encode("ai "),
      },
      {
        recordId: "r2",
        entryId: "turn-hub:assistant",
        entryOrder: 1,
        contentSlot: "text",
        partIndex: 1,
        kind: "text",
        payload: encoder.encode("ai"),
      },
    ]);
    const hub = createSyncContentProjectionHub({ onProjection: () => {} });
    hub.applyUpdate({ docId: "sync/content/gen/0/nonce", generation: "gen", payload: Y.encodeStateAsUpdate(content) });
    const sync = hub.snapshot().messages;
    // 真实投影把工具前后的正文压成一条、且不含工具位置（本轮修复的输入事实）。
    expect(sync).toHaveLength(1);

    const merger = createSyncMessageMerger();
    const mid = merger(chatDocEntriesToStructuredMessages(chat), sync);
    expect(mid.map((message) => message.id)).toEqual([
      "turn-hub:user",
      "turn-hub:assistant",
      "tool-h",
      "turn-hub:assistant#1",
    ]);
    expect(mid.map((message) => textOf(message)).join("")).toBe("ai ai");

    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "ai" } }));
    const done = merger(chatDocEntriesToStructuredMessages(chat), sync);
    expect(done.map((message) => message.id)).toEqual([
      "turn-hub:user",
      "turn-hub:assistant",
      "tool-h",
      "turn-hub:assistant#1",
    ]);
    expect(done.map((message) => textOf(message)).join("")).toBe("ai ai");
    expect(done.filter((message) => message.type === "assistant_message")).toHaveLength(2);

    hub.dispose();
    content.destroy();
  });

  // 对抗验证 M02/M03/M09：多段多工具完整终态必须严格按旧结构顺序，不重排、不重复、不额外合成段。
  test("多段多工具终态保持严格顺序且新投影不重复", () => {
    const segments = [assistant("e", "A"), tool("t1"), assistant("e#1", "B"), tool("t2"), assistant("e#2", "C")];
    const merged = createSyncMessageMerger()(segments, [assistant("e", "ABC", 0)]);
    expect(merged.map((message) => message.id)).toEqual(["e", "t1", "e#1", "t2", "e#2"]);
    expect(merged.map((message) => textOf(message))).toEqual(["A", "", "B", "", "C"]);
  });

  // 对抗验证 M04/M05：空白段与空尾段不得产生额外合成消息，也不得吞掉旧侧空白。
  test("空白尾段与空尾段不产生多余消息", () => {
    const blank = createSyncMessageMerger()(
      [assistant("e", "A"), tool("t"), assistant("e#1", "  ")],
      [assistant("e", "A  ", 0)],
    );
    expect(blank.map((message) => message.id)).toEqual(["e", "t", "e#1"]);
    expect(blank.map((message) => textOf(message)).join("")).toBe("A  ");

    const empty = createSyncMessageMerger()([assistant("e", "A"), tool("t")], [assistant("e", "A", 0)]);
    expect(empty.map((message) => message.id)).toEqual(["e", "t"]);
  });

  // 对抗验证 M11：用户与助手同 id 时不能互相顶替，两侧正文都必须可见。
  test("用户与助手同 key 时助手正文不得丢失", () => {
    const merged = createSyncMessageMerger()([user("e", "问")], [assistant("e", "答", 0)]);
    expect(merged.map((message) => message.id)).toEqual(["e", "sync:e"]);
    expect(merged[0]).toMatchObject({ type: "user_message", content: "问" });
    expect(merged[1]).toMatchObject({ type: "assistant_message" });
    expect(textOf(merged[1]!)).toBe("答");
  });

  // 对抗验证 M12：entryId 自身含 "#" 时按同一基名分组，分段顺序与工具位置不变。
  test("entryId 含 # 时仍按分段结构保持顺序", () => {
    const merged = createSyncMessageMerger()(
      [assistant("e#1", "A"), tool("t"), assistant("e#1#1", "B")],
      [assistant("e#1", "AB", 0)],
    );
    expect(merged.map((message) => message.id)).toEqual(["e#1", "t", "e#1#1"]);
    expect(merged.map((message) => textOf(message))).toEqual(["A", "", "B"]);
  });

  // 对抗验证 M08/R02：旧侧永久不追平、新侧已 final 时，尾文在任何时钟下都必须可见。
  test("旧侧停滞且新侧 final 后尾文仍然可见", () => {
    let clock = 10_000;
    const merge = createSyncMessageMerger(() => clock);
    const legacy = [assistant("e", "A"), tool("t"), assistant("e#1", "B")];
    for (clock of [10_000, 70_000, 3_600_000]) {
      const merged = merge(legacy, [assistant("e", "ABFINAL", 0)]);
      expect(merged.map((message) => message.id)).toEqual(["e", "t", "e#1"]);
      expect(merged.map((message) => textOf(message)).join("")).toBe("ABFINAL");
    }

    // 旧侧永久只有首段 + 工具：尾文仍排在该工具之后。
    const stalled = createSyncMessageMerger()([assistant("e", "A"), tool("t")], [assistant("e", "ABFINAL", 0)]);
    expect(stalled.map((message) => message.id)).toEqual(["e", "t", "e#1"]);
    expect(stalled.map((message) => textOf(message)).join("")).toBe("ABFINAL");
  });

  // 真实 Chat Doc 切分 → 合并器：工具前后多段正文、多工具与错误终态都必须保留最终答案（B02）。
  test("真实 Chat Doc 的多段正文与工具顺序经合并后不丢最终答案", () => {
    const chat = createChatDoc("rcs-real-merge", null).ydoc;
    const session = createSessionDoc("rcs-real-merge", null).ydoc;
    const pair = { chat, session };
    const event = (
      type: NormalizedEvent["type"],
      update: Record<string, unknown> = {},
      turnId?: string,
    ): NormalizedEvent =>
      ({ type, update, content: (update.content as Record<string, unknown>) ?? null, turnId }) as NormalizedEvent;
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "问题" } }, "turn-real"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "前文" } }, "turn-real"));
    applyNormalizedEvent(pair, event("reasoning_delta", { content: { type: "text", text: "思考" } }, "turn-real"));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "tool-a", title: "Read" }, "turn-real"));
    applyNormalizedEvent(
      pair,
      event("tool_call_completed", { toolCallId: "tool-a", status: "completed" }, "turn-real"),
    );
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "tool-b", title: "Grep" }, "turn-real"));
    applyNormalizedEvent(pair, event("tool_call_completed", { toolCallId: "tool-b", status: "failed" }, "turn-real"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "最终答案" } }, "turn-real"));
    applyNormalizedEvent(pair, event("turn_failed", {}, "turn-real"));

    const legacy = chatDocEntriesToStructuredMessages(chat);
    const sync = [assistant("turn-real:assistant", "前文最终答案", 0)];
    const merged = createSyncMessageMerger()(legacy, sync);
    const visible = merged.map((message) => (message.type === "assistant_message" ? textOf(message) : "")).join("");
    expect(visible).toContain("最终答案");
    expect(visible.split("最终答案")).toHaveLength(2);
    expect(merged.some((message) => message.type === "tool_call" && message.id === "tool-a")).toBe(true);
    expect(merged.some((message) => message.type === "tool_call" && message.id === "tool-b")).toBe(true);
  });

  // 分页缺段时旧结构不完整：合并器必须保留新投影的整条正文兜底，不能把最终答案整条删除（B02）。
  test("分页缺段时保留新投影正文兜底", () => {
    const chat = createChatDoc("rcs-real-page", null).ydoc;
    const session = createSessionDoc("rcs-real-page", null).ydoc;
    const pair = { chat, session };
    const event = (
      type: NormalizedEvent["type"],
      update: Record<string, unknown> = {},
      turnId?: string,
    ): NormalizedEvent =>
      ({ type, update, content: (update.content as Record<string, unknown>) ?? null, turnId }) as NormalizedEvent;
    applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "问题" } }, "turn-page"));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "前文" } }));
    applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "tool-page", title: "Read" }));
    applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "最终答案" } }));

    const full = chatDocEntriesToStructuredMessages(chat);
    // 模拟分页只拿到工具前内容，缺少 entryId#1 的最终答案段。
    const paged = full.filter((message) => message.type !== "tool_call" && !message.id.includes("#"));
    const sync = [assistant("turn-page:assistant", "前文最终答案", 0)];
    const merged = createSyncMessageMerger()(paged, sync);
    const visible = merged.map((message) => (message.type === "assistant_message" ? textOf(message) : "")).join("");
    expect(visible).toContain("最终答案");
  });

  // 新投影覆盖助手正文后该助手副本退役；未配对用户消息没有身份证明，必须保留（B01）。
  test("新投影覆盖助手文本但保留未配对用户消息", () => {
    const tool: StructuredMessage = {
      type: "tool_call",
      id: "tool",
      title: "读取文件",
      status: "complete",
      content: [],
    };
    const plan: StructuredMessage = {
      type: "plan",
      id: "plan",
      entries: [{ content: "步骤", priority: "high", status: "completed" }],
    };
    const thought: StructuredMessage = {
      type: "assistant_message",
      id: "thought",
      chunks: [{ type: "thought", text: "内部推理" }],
      seq: 2,
      ts: 0,
    };
    const failed: StructuredMessage = {
      type: "assistant_message",
      id: "failed",
      chunks: [{ type: "message", text: "失败" }],
      seq: 3,
      ts: 0,
      error: { type: "AGENT_RUNTIME.PROMPT_REJECTED", id: "err-1", message: "拒绝" },
    };
    const merged = createSyncMessageMerger()(
      [user("legacy:user", "旧提问"), assistant("legacy:assistant", "旧回答"), tool, plan, thought, failed],
      [assistant("sync:assistant", "旧回答", 0)],
    );
    expect(merged.map((message) => message.id)).toEqual([
      "legacy:user",
      "tool",
      "plan",
      "thought",
      "failed",
      "sync:assistant",
    ]);
  });

  // 新投影为空时旧全量仍是唯一来源；显式关闭退役可保留旧合并语义。
  test("新投影无文本时保留旧全量", () => {
    const history = [user("u", "历史提问"), assistant("a", "历史回答")];
    expect(createSyncMessageMerger()(history, []).map((message) => message.id)).toEqual(["u", "a"]);
    expect(
      createSyncMessageMerger(undefined, { retireLegacyText: false })(history, [assistant("live", "实时回答")]).map(
        (message) => message.id,
      ),
    ).toEqual(["u", "a", "live"]);
  });

  // 身份配对优先于退役：同 entryId 的旧文本仍参与“更完整一侧”选择，不会因退役丢消息。
  test("已配对旧文本不因退役被丢弃", () => {
    const merged = createSyncMessageMerger()([assistant("same", "完整回答")], [assistant("same", "答")]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "same", type: "assistant_message" });
  });

  // 只有旧历史时用户和助手正文可见。
  test("只有旧历史时用户和助手正文可见", async () => {
    const history = [user("u", "历史提问"), assistant("a", "历史回答")];
    const merged = createSyncMessageMerger()(history, []);
    expect(merged).toEqual(history);
    const html = await renderMessages(merged);
    expect(html).toContain("历史提问");
    expect(html).toContain("历史回答");
  });

  // 新协议消息无需旧 Doc 副本，也能由现有消息组件显示。
  test("只有新消息时用户和助手正文可见", async () => {
    const merged = createSyncMessageMerger()([], [user("n:user", "新提问"), assistant("n:assistant", "新回答")]);
    const html = await renderMessages(merged);
    expect(html).toContain("新提问");
    expect(html).toContain("新回答");
  });

  // 同 entryId 优先身份去重，流式内容采用更完整的新文本。
  test("同 entryId 双写只显示一次且新文本参与渲染", async () => {
    const merged = createSyncMessageMerger()([assistant("a", "答")], [assistant("a", "完整回答")]);
    expect(merged).toHaveLength(1);
    const html = await renderMessages(merged);
    expect(html.match(/完整回答/g)).toHaveLength(1);
  });

  // 用户消息双写可能因重连晚到而超出五秒窗口，按出现次数与轮次锚点配对，不能重复展示。
  test("异 ID 用户消息跨五秒窗口仍按出现次数去重", () => {
    const union = () => createSyncMessageMerger(undefined, { retireLegacyText: false });
    expect(union()([user("old", "收到")], [user("new", "收到", 14000)])).toHaveLength(1);
    expect(union()([user("old", "收到")], [user("new", "收到", 16000)])).toHaveLength(1);
    expect(union()([user("old", "收到")], [assistant("new", "收到")])).toHaveLength(2);
    // 旧通道多出的一次是真实重复提问，不能被新投影的一条消息抵消。
    expect(union()([user("a", "收到"), user("b", "收到")], [user("c", "收到")])).toHaveLength(2);
  });

  // 缺少协议时间戳时仍要按出现顺序配对，不能因首次观察时间较晚而重复展示同一条。
  test("未知时间的用户消息按出现顺序配对", () => {
    const unionAt = (time: number) => createSyncMessageMerger(() => time, { retireLegacyText: false });
    expect(unionAt(10000)([user("a", "收到")], [user("b", "收到", 0)])).toHaveLength(1);
    expect(unionAt(30000)([user("a", "收到")], [user("b", "收到", 0)])).toHaveLength(1);
  });

  // 双写追平或时间戳更新不能重挂已显示条目，追加消息也不能重建未变气泡对象。
  test("追平、流式增长与追加保留 key、相对顺序和未变 UI 引用", () => {
    const merge = createSyncMessageMerger(() => 10000, { retireLegacyText: false });
    const history = user("history", "历史", 1);
    const live = assistant("new", "回答", 0);
    const first = merge([history], [live]);
    const rendered = structuredToThreadEntries(first);
    const second = merge([history, assistant("old", "回答")], [live]);
    expect(second.map((m) => m.id)).toEqual(["history", "new"]);
    const third = merge(
      [history, assistant("old", "回答变长")],
      [assistant("new", "回答变长", 9000), user("next", "继续")],
    );
    expect(third.map((m) => m.id)).toEqual(["history", "new", "next"]);
    expect(third[0]).toBe(first[0]);
    expect(structuredToThreadEntries(third)[0]).toBe(rendered[0]);
    expect(
      merge([history, assistant("old", "回答变长")], [assistant("new", "回答变长", 9000), user("next", "继续")]),
    ).toBe(third);
  });

  // 模糊候选不得抢走已有精确身份配对，也不能把后续旧消息插到实时回复之前。
  test("精确身份优先且较晚旧消息排在实时回复后", () => {
    expect(
      createSyncMessageMerger(undefined, { retireLegacyText: false })(
        [user("exact", "相同")],
        [user("other", "相同"), user("exact", "相同")],
      ),
    ).toHaveLength(2);
    const merge = createSyncMessageMerger(undefined, { retireLegacyText: false });
    const history = user("history", "历史", 1);
    const live = assistant("live", "回复", 10000);
    merge([history], [live]);
    expect(merge([history, user("later", "后续", 20000)], [live]).map((m) => m.id)).toEqual([
      "history",
      "live",
      "later",
    ]);
  });

  // 后到历史按旧 Doc 顺序补在实时消息之前，旧侧连续追加不逆序。
  test("历史晚到及旧消息追加保持顺序", () => {
    const merge = createSyncMessageMerger(undefined, { retireLegacyText: false });
    merge([], [assistant("live", "实时")]);
    expect(merge([user("h1", "一"), assistant("h2", "二")], [assistant("live", "实时")]).map((m) => m.id)).toEqual([
      "h1",
      "h2",
      "live",
    ]);
    const legacyMerge = createSyncMessageMerger(undefined, { retireLegacyText: false });
    legacyMerge([user("1", "一")], []);
    expect(legacyMerge([user("1", "一"), user("2", "二"), user("3", "三")], []).map((m) => m.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  // 完整基线后到（异 ID）可跨 5 秒窗口配对一次；正常实时合并仍保留时间窗口，避免误吞重复输入。
  test("完整基线后到可放宽配对窗口", () => {
    let now = 10000;
    const merge = createSyncMessageMerger(() => now, { retireLegacyText: false });
    merge([assistant("legacy_old", "answer")], []);
    now = 20000;
    expect(merge([assistant("legacy_old", "answer")], [assistant("sync_new", "answer", 0)])).toHaveLength(2);
    expect(
      merge([assistant("legacy_old", "answer")], [assistant("sync_new", "answer", 0)], Number.POSITIVE_INFINITY),
    ).toHaveLength(1);
  });

  // 大基线双写（1000 对异 ID 同正文）的正文读取是线性的；旧实现对每条 sync 消息扫描全部 legacy，
  // 读取次数为 O(n²)，大会话 hydrate 时会独占主线程。阈值 20n 只约束复杂度，不约束具体实现。
  test("异 ID 大基线模糊配对不退化", () => {
    const counter = { reads: 0 };
    const legacy = Array.from({ length: 1000 }, (_, index) =>
      countedAssistant(`legacy_${index}`, `answer ${index}`, counter),
    );
    const sync = Array.from({ length: 1000 }, (_, index) =>
      countedAssistant(`sync_${index}`, `answer ${index}`, counter),
    );
    const merged = createSyncMessageMerger(() => 10000)(legacy, sync);
    expect(merged).toHaveLength(1000);
    expect(counter.reads).toBeLessThan(20 * 1000);
  });
});
