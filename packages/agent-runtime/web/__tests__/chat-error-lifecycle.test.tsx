import { afterEach, expect, test } from "bun:test";
import { createPublicError, encodeYjsReplaceFrame, encodeYjsUpdateFrame } from "@fenix/chat-channel";
import { act } from "react";
import * as Y from "yjs";
import {
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

// 回执只能结算同一命令的临时提示；未知命令结果不能因为另一条成功就消失。
test("成功回执按 commandId 清除操作提示，切会话隐藏旧提示", () => {
  installFakeWebSocket();
  const h = renderRuntime();
  const socket = legacySockets()[0]!;
  const receive = (frame: Record<string, unknown>) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
  const key = h.latest.current!.rcsSessionKey!;
  try {
    act(() => socket.open());
    act(() => h.latest.current!.callbacks.onSetMode("first-mode"));
    const commandId = JSON.parse(
      socket.sent.findLast((raw) => typeof raw === "string" && raw.includes("set_session_mode")) as string,
    ).commandId;
    receive({ type: "action_error", commandId, error: createPublicError("ACTION.OUTCOME_UNKNOWN") });
    receive({ type: "action_ack", commandId: "other-command", status: "committed" });
    expect(h.latest.current?.actionErrors[0]?.commandId).toBe(commandId);
    receive({ type: "action_ack", commandId, status: "duplicate" });
    expect(h.latest.current?.actionErrors).toEqual([]);
    act(() => h.latest.current!.callbacks.onSetMode("old-mode"));
    const oldId = JSON.parse(
      socket.sent.findLast((raw) => typeof raw === "string" && raw.includes("set_session_mode")) as string,
    ).commandId;
    receive({ type: "action_error", commandId: oldId, error: createPublicError("ACTION.FAILED") });
    for (const prefix of ["chat", "session"]) {
      const doc = new Y.Doc();
      if (prefix === "session") doc.getMap("root").set("session", new Y.Map([["sessionId", "ses-next"]]));
      act(() =>
        socket.onmessage?.({
          data: encodeYjsReplaceFrame(`${prefix}:${key}`, "next", Y.encodeStateAsUpdate(doc)),
        } as MessageEvent),
      );
      doc.destroy();
    }
    expect(h.latest.current?.actionErrors).toEqual([]);
  } finally {
    h.unmount();
  }
});

// 连接恢复只消除相应同步提示，未知故障仍需用户看到，不能按在线状态批量清除。
test("完整重连只清理同步来源的旧连接错误", () => {
  installFakeWebSocket();
  const h = renderRuntime();
  const socket = legacySockets()[0]!;
  const receive = (frame: Record<string, unknown>) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
  const key = h.latest.current!.rcsSessionKey!;
  const docs = [`chat:${key}`, `session:${key}`];
  try {
    act(() => socket.open());
    for (const name of docs) {
      const doc = new Y.Doc();
      act(() =>
        socket.onmessage?.({
          data: encodeYjsUpdateFrame(name, "reconnected", Y.encodeStateAsUpdate(doc)),
        } as MessageEvent),
      );
      doc.destroy();
    }
    receive({ type: "error", payload: createPublicError("SYNC_RELAY.CONNECTION_LOST") });
    receive({ type: "yjs:sync-complete", docs, generation: "reconnected" });
    expect(h.latest.current?.classifiedError).toBeNull();
    const unknown = createPublicError("INTERNAL.UNCLASSIFIED");
    receive({ type: "error", payload: unknown });
    receive({ type: "yjs:sync-complete", docs, generation: "reconnected" });
    expect(h.latest.current?.classifiedError).toEqual(unknown);
  } finally {
    h.unmount();
  }
});

// 重连预算耗尽后 transport 已终止，展示不能继续声称系统正在自动恢复。
test("短连接重试耗尽后停止重连提示并保留真实错误", () => {
  installFakeWebSocket();
  const previousTimeout = Object.getOwnPropertyDescriptor(globalThis, "setTimeout")!;
  const timers: Array<{ callback: () => void; delay?: number }> = [];
  Object.defineProperty(globalThis, "setTimeout", {
    configurable: true,
    value: (callback: () => void, delay?: number) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
  });
  const h = renderRuntime();
  const error = createPublicError("SYNC_RELAY.CONNECTION_LOST");
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const socket = legacySockets().at(-1)!;
      act(() => {
        socket.open();
        socket.onmessage?.({ data: JSON.stringify({ type: "error", payload: error }) } as MessageEvent);
        socket.closeFromServer(1006, "lost");
      });
      if (attempt < 5) {
        const index = timers.findIndex((timer) => timer.delay === 1000 * 2 ** attempt);
        expect(index).toBeGreaterThanOrEqual(0);
        act(() => timers.splice(index, 1)[0]!.callback());
      }
    }
    expect(h.latest.current?.connectionState).toBe("error");
    expect(h.latest.current?.autoReconnecting).toBe(false);
    expect(h.latest.current?.classifiedError?.id).toBe(error.id);
    expect(legacySockets()).toHaveLength(6);
  } finally {
    h.unmount();
    Object.defineProperty(globalThis, "setTimeout", previousTimeout);
  }
});

// 迟到重复的旧命令失败必须留在原会话，不能因为首次通知已被消费而重新归属当前会话。
test("切会话后重复旧 action_error 不会重现", () => {
  installFakeWebSocket();
  const h = renderRuntime();
  const socket = legacySockets()[0]!;
  const key = h.latest.current!.rcsSessionKey!;
  const receive = (frame: Record<string, unknown>) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
  try {
    act(() => {
      socket.open();
      h.latest.current!.callbacks.onSetMode("test-mode");
    });
    const command = socket.sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((raw) => JSON.parse(raw))
      .find((frame) => frame.action === "set_session_mode");
    const failure = { type: "action_error", commandId: command.commandId, error: createPublicError("ACTION.FAILED") };
    receive(failure);
    expect(h.latest.current?.actionErrors[0]?.commandId).toBe(command.commandId);
    for (const prefix of ["chat", "session"]) {
      const doc = new Y.Doc();
      if (prefix === "session") doc.getMap("root").set("session", new Y.Map([["sessionId", "ses-next"]]));
      act(() =>
        socket.onmessage?.({
          data: encodeYjsReplaceFrame(`${prefix}:${key}`, "next-late", Y.encodeStateAsUpdate(doc)),
        } as MessageEvent),
      );
      doc.destroy();
    }
    receive(failure);
    expect(h.latest.current?.actionErrors).toEqual([]);
  } finally {
    h.unmount();
  }
});
