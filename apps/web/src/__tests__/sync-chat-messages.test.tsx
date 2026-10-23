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
import { createSyncMessageMerger } from "../../../../packages/agent-runtime/web/hooks/sync-chat-messages";

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

  // 流式中间态：工具已到、工具后的正文尚未成段时，新投影把前后两段拼成的整段文本不能前移到工具之前，
  // 否则用户会看到 "ai ai tools"（工具后正文跑到工具前）；旧路径补齐成段后必须恢复原顺序且不重复。
  test("工具后正文未成段时新投影整段文本不得前移到工具之前", () => {
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

    // 中间态：旧路径只有首段 + 工具，新投影已包含工具后的正文（整段文本）
    const merger = createSyncMessageMerger();
    const mid = merger(chatDocEntriesToStructuredMessages(chat), [assistant("turn-stream:assistant", "ai ai", 0)]);
    expect(mid.map((message) => message.id)).toEqual(["turn-stream:user", "turn-stream:assistant", "tool-s"]);
    expect(mid[1]).toMatchObject({ type: "assistant_message" });
    expect(textOf(mid[1]!)).toBe("ai ");

    // 旧路径补齐第二段：工具后的正文必须排在工具之后，且整段文本不得再出现
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
