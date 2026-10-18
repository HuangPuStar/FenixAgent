import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { AssistantBubble, UserBubble } from "@fenix/ui-components/chat/view/MessageBubble";
import { structuredToThreadEntries } from "@fenix/web-runtime/chat/structured-to-thread";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToReadableStream } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { createSyncMessageMerger } from "../../../../packages/agent-runtime/web/hooks/sync-chat-messages";

function user(id: string, content: string, ts = 10000): StructuredMessage {
  return { type: "user_message", id, content, ts, seq: 0 };
}
function assistant(id: string, text: string, ts = 10000): StructuredMessage {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], ts, seq: 1 };
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
  // 新投影为空时，完整旧历史仍通过现有气泡可见。
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

  // ID 不同但角色、正文和时间窗口相同的一对双写只保留一条。
  test("异 ID 按角色正文及五秒窗口一对一去重", () => {
    const merge = createSyncMessageMerger(() => 10000);
    expect(merge([user("old", "收到")], [user("new", "收到", 14000)])).toHaveLength(1);
    expect(createSyncMessageMerger()([user("old", "收到")], [user("new", "收到", 16000)])).toHaveLength(2);
    expect(createSyncMessageMerger()([user("old", "收到")], [assistant("new", "收到")])).toHaveLength(2);
    expect(createSyncMessageMerger()([user("a", "收到"), user("b", "收到")], [user("c", "收到")])).toHaveLength(2);
  });

  // 无 final 时间戳只能使用首次观察窗口，不能吞掉很久以前相同正文。
  test("未知时间使用首次观察时间且不会误吞旧历史", () => {
    expect(createSyncMessageMerger(() => 10000)([user("a", "收到")], [user("b", "收到", 0)])).toHaveLength(1);
    expect(createSyncMessageMerger(() => 30000)([user("a", "收到")], [user("b", "收到", 0)])).toHaveLength(2);
  });

  // 双写追平或时间戳更新不能重挂已显示条目，追加消息也不能重建未变气泡对象。
  test("追平、流式增长与追加保留 key、相对顺序和未变 UI 引用", () => {
    const merge = createSyncMessageMerger(() => 10000);
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
      createSyncMessageMerger()([user("exact", "相同")], [user("other", "相同"), user("exact", "相同")]),
    ).toHaveLength(2);
    const merge = createSyncMessageMerger();
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
    const merge = createSyncMessageMerger();
    merge([], [assistant("live", "实时")]);
    expect(merge([user("h1", "一"), assistant("h2", "二")], [assistant("live", "实时")]).map((m) => m.id)).toEqual([
      "h1",
      "h2",
      "live",
    ]);
    const legacyMerge = createSyncMessageMerger();
    legacyMerge([user("1", "一")], []);
    expect(legacyMerge([user("1", "一"), user("2", "二"), user("3", "三")], []).map((m) => m.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });
});
