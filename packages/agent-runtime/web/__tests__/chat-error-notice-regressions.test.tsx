import { afterEach, expect, test } from "bun:test";
import { createPublicError, encodeYjsReplaceFrame } from "@fenix/chat-channel";
import { act, createElement, startTransition, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { useChatErrorNotices } from "../agent-panel/use-chat-error-notices";
import {
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

/** 在真实 React 更新队列中观察提示归属与回收，不替换 hook。 */
function renderNotices() {
  let latest: ReturnType<typeof useChatErrorNotices>;
  let changeScope: (scope: string) => void;
  function Probe() {
    const [scope, setScope] = useState("session-a");
    changeScope = setScope;
    latest = useChatErrorNotices(scope);
    return createElement("span", null, latest.actionErrors.map((item) => item.error.id).join(","));
  }
  const host = win.document.createElement("div");
  const root = createRoot(host as unknown as HTMLElement);
  act(() => root.render(createElement(Probe)));
  return {
    get current() {
      return latest!;
    },
    changeScope: (scope: string) => changeScope!(scope),
    host,
    unmount: () => act(() => root.unmount()),
  };
}

// 主动关闭不能被晚到的同一故障撤销，独立的新故障仍须展示。
test("关闭后的重复操作错误保持隐藏，新 Error ID 仍可见", () => {
  const h = renderNotices();
  const error = { commandId: "command-a", error: createPublicError("ACTION.FAILED") };
  try {
    act(() => h.current.showActionError(error));
    act(() => h.current.dismissActionError(error.error.id));
    act(() => h.current.showActionError(error));
    expect(h.host.textContent).not.toContain(error.error.id);
    const independent = { ...error, error: createPublicError("ACTION.FAILED") };
    act(() => h.current.showActionError(independent));
    expect(h.host.textContent).toContain(independent.error.id);
  } finally {
    h.unmount();
  }
});

// 低优先级更新被切会话打断后，不得在重放时读取新 scope 并重新认领旧错误。
test("排队中的旧错误不能随 React 更新重放进入新会话", async () => {
  const h = renderNotices();
  const first = { commandId: "first", error: createPublicError("ACTION.FAILED") };
  const queued = { commandId: "queued", error: createPublicError("ACTION.FAILED") };
  try {
    act(() => h.current.showActionError(first));
    await act(async () => {
      startTransition(() => h.current.showActionError(queued));
      h.changeScope("session-b");
    });
    expect(h.host.textContent).not.toContain(queued.error.id);
  } finally {
    h.unmount();
  }
});

// 完整旧基线只证明旧连接恢复，SYNC_FAILED 还须主同步恢复确认才能清除。
test("同步失败保留到主同步与基线共同恢复", () => {
  const h = renderNotices();
  const error = createPublicError("SYNC_RELAY.SYNC_FAILED");
  try {
    act(() => h.current.setClassifiedError(error));
    act(() => h.current.clearRecoveredConnectionError());
    expect(h.current.classifiedError?.id).toBe(error.id);
    act(() => h.current.clearRecoveredConnectionError(true));
    expect(h.current.classifiedError).toBeNull();
  } finally {
    h.unmount();
  }
});

// 有界历史淘汰后不应把未知来源重新归属当前会话，也不能丢弃仍在途的新命令。
test("命令历史淘汰后拒绝旧错误，并保留当前在途命令的反馈", () => {
  installFakeWebSocket();
  const h = renderRuntime();
  const socket = legacySockets()[0]!;
  const receive = (frame: Record<string, unknown>) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
  const sendMode = (mode: string): string => {
    act(() => h.latest.current!.callbacks.onSetMode(mode));
    const frames = socket.sent.filter((raw): raw is string => typeof raw === "string").map((raw) => JSON.parse(raw));
    return frames.findLast((frame) => frame.action === "set_session_mode").commandId;
  };
  try {
    act(() => socket.open());
    const old = sendMode("old");
    receive({ type: "action_ack", commandId: old, status: "committed" });
    const key = h.latest.current!.rcsSessionKey!;
    for (const prefix of ["chat", "session"]) {
      const doc = new Y.Doc();
      if (prefix === "session") doc.getMap("root").set("session", new Y.Map([["sessionId", "ses-next"]]));
      act(() =>
        socket.onmessage?.({
          data: encodeYjsReplaceFrame(`${prefix}:${key}`, "next-eviction", Y.encodeStateAsUpdate(doc)),
        } as MessageEvent),
      );
      doc.destroy();
    }
    const inFlight = sendMode("in-flight");
    for (let i = 0; i < 300; i++) {
      const id = sendMode(`current-${i}`);
      receive({ type: "action_ack", commandId: id, status: "committed" });
    }
    receive({ type: "action_error", commandId: old, error: createPublicError("ACTION.FAILED") });
    expect(h.latest.current?.actionErrors).toEqual([]);
    const currentError = createPublicError("ACTION.FAILED");
    receive({ type: "action_error", commandId: inFlight, error: currentError });
    expect(h.latest.current?.actionErrors.map((item) => item.error.id)).toEqual([currentError.id]);
  } finally {
    h.unmount();
  }
});
