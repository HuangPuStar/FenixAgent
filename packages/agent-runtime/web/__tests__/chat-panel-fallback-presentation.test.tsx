import { afterEach, expect, spyOn, test } from "bun:test";
import { encodeYjsReplaceFrame, encodeYjsUpdateFrame } from "@fenix/chat-channel";
import { act } from "react";
import * as Y from "yjs";
import {
  type FakeWebSocket,
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
  runtimeGlobal,
  syncSockets,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

/** 通过真实帧投递会话元信息与两份文档，验证展示层接线。 */
function deliver(socket: FakeWebSocket, key: string, generation: string, replace = false) {
  for (const prefix of ["chat", "session"]) {
    const doc = new Y.Doc();
    if (prefix === "session") {
      const session = new Y.Map<unknown>();
      doc.getMap("root").set("session", session);
      session.set("sessionId", "ses_fallback");
      session.set("status", "ready");
      session.set("replayState", "complete");
    }
    act(() =>
      socket.onmessage?.({
        data: (replace ? encodeYjsReplaceFrame : encodeYjsUpdateFrame)(
          `${prefix}:${key}`,
          generation,
          Y.encodeStateAsUpdate(doc),
        ),
      } as MessageEvent),
    );
    doc.destroy();
  }
}

// 新连接、投影换代和历史缺失都必须撤销静默资格；1011 本身不能证明接管成功。
test("1011 接管必须等当前连接、完整基线与就绪会话", async () => {
  installFakeWebSocket();
  const storage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  runtimeGlobal.localStorage = win.localStorage;
  win.localStorage.setItem("active_org_id", "org-fallback");
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  const harness = renderRuntime();
  const socket = legacySockets()[0]!;
  const key = harness.latest.current!.rcsSessionKey!;
  const docs = [`chat:${key}`, `session:${key}`];
  const complete = (generation: string) =>
    act(() =>
      socket.onmessage?.({ data: JSON.stringify({ type: "yjs:sync-complete", docs, generation }) } as MessageEvent),
    );
  try {
    act(() => {
      socket.open();
      syncSockets()[0]!.closeFromServer(1011, "private close reason");
    });
    expect(harness.latest.current?.legacyFallbackUsable).toBe(false);
    deliver(socket, key, "g1");
    expect(harness.latest.current?.legacyFallbackUsable).toBe(false);
    complete("wrong-generation");
    expect(harness.latest.current?.legacyFallbackUsable).toBe(false);
    complete("g1");
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(harness.latest.current?.legacyFallbackUsable).toBe(true);
    const sent = socket.sent.length;
    act(() => harness.latest.current!.callbacks.onSendPrompt([{ type: "text", text: "still usable" }]));
    expect(socket.sent.length).toBeGreaterThan(sent);
    expect(
      JSON.stringify(warn.mock.calls.filter((call) => call[0] === "[sync-chat] fallback to legacy")),
    ).not.toContain("private close reason");
    const count = warn.mock.calls.length;
    complete("g1");
    expect(warn.mock.calls.length).toBe(count);
    deliver(socket, key, "g2", true);
    expect(harness.latest.current?.legacyFallbackUsable).toBe(false);
    act(() => syncSockets().at(-1)!.closeFromServer(1011, "other private reason"));
    complete("g1");
    expect(harness.latest.current?.legacyFallbackUsable).toBe(false);
    complete("g2");
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(harness.latest.current?.legacyFallbackUsable).toBe(true);
    act(() =>
      socket.onmessage?.({
        data: JSON.stringify({
          type: "yjs:history-incomplete",
          docs,
          generation: "g2",
          reason: "too_large",
          bytes: 100,
          limitBytes: 10,
        }),
      } as MessageEvent),
    );
    expect(harness.latest.current?.legacyFallbackUsable).toBe(false);
    expect(harness.latest.current?.syncDegradedBlocked).toBe(true);
    const stale = socket.onmessage;
    act(() => harness.latest.current!.retryHistoryRecovery());
    act(() => stale?.({ data: JSON.stringify({ type: "yjs:sync-complete", docs, generation: "g2" }) } as MessageEvent));
    expect(harness.latest.current?.legacyFallbackUsable).toBe(false);
  } finally {
    harness.unmount();
    warn.mockRestore();
    win.localStorage.clear();
    if (storage) Object.defineProperty(globalThis, "localStorage", storage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
