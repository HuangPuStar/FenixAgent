import { expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { Conversation } from "@fenix/ui-components/chat/primitives/conversation";
import { PromptJumpRail } from "@fenix/ui-components/chat/view/chat-navigation-aids";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import * as Y from "yjs";
import { createSyncMessageMerger } from "../hooks/sync-chat-messages";
import { createSyncContentProjectionHub } from "../yjs/sync-doc-hub";

interface HistoryPart {
  entryId: string;
  role?: "user" | "assistant";
  text: string;
  entryOrder?: number;
  toolCallId?: string;
}

/** 模拟网络交付的历史 content Doc；角色与正文分开编码。 */
function contentDoc(parts: readonly HistoryPart[]): Y.Doc {
  const doc = new Y.Doc();
  const records = new Y.Array<Record<string, unknown>>();
  doc.getMap("root").set("records", records);
  records.push(
    parts.map((part, index) => ({
      recordId: `${part.entryId}:${index}`,
      entryId: part.entryId,
      ...(part.role === undefined ? {} : { role: part.role }),
      entryOrder: part.entryOrder ?? index,
      contentSlot: 0,
      partIndex: index,
      kind: part.toolCallId ? "tool_boundary" : "text_part",
      payload: new TextEncoder().encode(
        JSON.stringify(part.toolCallId ? { toolCallId: part.toolCallId, ordinal: 0 } : part.text),
      ),
    })),
  );
  return doc;
}

function user(id: string, content: string): StructuredMessage {
  return { id, type: "user_message", content, seq: 0, ts: 1000 };
}

function assistant(id: string, text: string): StructuredMessage {
  return { id, type: "assistant_message", chunks: [{ type: "message", text }], seq: 0, ts: 1000 };
}

// callback 用户 ID 不带 :user；刷新、重复帧与跨块乱序到达后仍保留正确问答/工具顺序和用户定位入口。
test("重复刷新后 callback 问答保持源角色与唯一时间线", () => {
  const legacy: StructuredMessage[] = [
    user("callback_q1", "广州今天的天气"),
    assistant("callback_q1:assistant", "正在查询"),
    { type: "tool_call", id: "weather-tool", title: "天气查询", status: "complete", content: [] },
    assistant("callback_q1:assistant#1", "晴天"),
    user("callback_q2", "广州明天的天气"),
    assistant("callback_q2:assistant", "明天有雨"),
  ];
  const docs = [
    contentDoc([
      { entryId: "callback_q1", role: "user", text: "广州今天的天气", entryOrder: 0 },
      { entryId: "callback_q1:assistant", role: "assistant", text: "正在查询", entryOrder: 1 },
      { entryId: "callback_q1:assistant", role: "assistant", text: "", toolCallId: "weather-tool", entryOrder: 1 },
    ]),
    contentDoc([
      { entryId: "callback_q1:assistant", role: "assistant", text: "晴天", entryOrder: 1 },
      { entryId: "callback_q2", role: "user", text: "广州明天的天气", entryOrder: 2 },
      { entryId: "callback_q2:assistant", role: "assistant", text: "明天有雨", entryOrder: 3 },
    ]),
  ];
  const hub = createSyncContentProjectionHub({ onProjection: () => {}, messageWindow: 2 });
  try {
    for (let refresh = 0; refresh < 3; refresh += 1) {
      hub.reset("roles");
      const merge = createSyncMessageMerger();
      merge(legacy, []);
      for (const index of [1, 0, 1]) {
        hub.applyUpdate({
          docId: `sync/content/roles/${index}/fixture`,
          generation: "roles",
          payload: Y.encodeStateAsUpdate(docs[index]!),
        });
        merge(legacy, hub.snapshot().messages);
      }
      expect(hub.snapshot().messages.map((message) => message.type)).toEqual(["user_message", "assistant_message"]);
      hub.growWindow(10);
      const sync = hub.snapshot().messages;
      expect(sync.filter((message) => message.type === "user_message").map((message) => message.id)).toEqual([
        "callback_q1",
        "callback_q2",
      ]);
      const merged = merge(legacy, sync);
      expect(merged.map((message) => [message.id, message.type])).toEqual(
        legacy.map((message) => [message.id, message.type]),
      );
      expect(new Set(merged.map((message) => message.id)).size).toBe(legacy.length);
      const i18n = createInstance();
      void i18n.init({ lng: "zh", initAsync: false });
      const rail = renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(
            Conversation,
            null,
            createElement(PromptJumpRail, {
              entries: merged.filter((message) => message.type === "user_message"),
            }),
          ),
        ),
      );
      expect(rail).toContain("广州今天的天气");
      expect(rail).toContain("广州明天的天气");
    }
  } finally {
    hub.dispose();
    for (const doc of docs) doc.destroy();
  }
});

// 源角色优先于 ID 后缀；同 Doc 内容更新时，角色变化必须使投影缓存失效。
test("明确角色优先于后缀且角色更新会刷新投影缓存", () => {
  const doc = contentDoc([{ entryId: "arbitrary:user", role: "assistant", text: "回答" }]);
  const hub = createSyncContentProjectionHub({ onProjection: () => {} });
  const update = () =>
    hub.applyUpdate({ docId: "sync/content/roles/0/cache", generation: "roles", payload: Y.encodeStateAsUpdate(doc) });
  try {
    update();
    expect(hub.snapshot().messages[0]?.type).toBe("assistant_message");
    const records = doc.getMap("root").get("records") as Y.Array<Record<string, unknown>>;
    const original = records.get(0)!;
    doc.transact(() => {
      records.delete(0, 1);
      records.insert(0, [{ ...original, role: "user" }]);
    });
    update();
    expect(hub.snapshot().messages[0]?.type).toBe("user_message");
  } finally {
    hub.dispose();
    doc.destroy();
  }
});

// 实时记录尚无显式角色，仍按既有 :user / :assistant 身份契约显示。
test("无角色实时记录保持既有角色契约", () => {
  const doc = contentDoc([
    { entryId: "turn:user", text: "问题" },
    { entryId: "turn:assistant", text: "回答" },
  ]);
  const hub = createSyncContentProjectionHub({ onProjection: () => {} });
  try {
    hub.applyUpdate({
      docId: "sync/content/roles/0/runtime",
      generation: "roles",
      payload: Y.encodeStateAsUpdate(doc),
    });
    expect(hub.snapshot().messages.map((message) => message.type)).toEqual(["user_message", "assistant_message"]);
  } finally {
    hub.dispose();
    doc.destroy();
  }
});
