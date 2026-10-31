import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { ACPMain } from "@fenix/ui-components/chat/shell/ACPMain";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { toast } from "sonner";
import * as Y from "yjs";
import type { ChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { useChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { createSessionDocBinding } from "../yjs/doc-hub";
import {
  FakeWebSocket,
  installFakeWebSocket,
  legacySockets,
  restoreFakeWebSocket,
  runtimeGlobal,
  win,
} from "./helpers/chat-panel-runtime-fixture";

const i18n = createInstance();
void i18n.use(initReactI18next).init({ lng: "zh", initAsync: false, resources: {} });
const epoch = "11111111-1111-4111-8111-111111111111";
const usePeriTaskViews = () => ({ state: { tasks: [], loaded: true } });
let toastErrors: ReturnType<typeof spyOn<typeof toast, "error">>;

beforeEach(() => {
  installFakeWebSocket();
  runtimeGlobal.ResizeObserver = win.ResizeObserver;
  runtimeGlobal.getComputedStyle = win.getComputedStyle.bind(win);
  toastErrors = spyOn(toast, "error").mockImplementation(() => "test-toast");
});
afterEach(() => {
  toastErrors.mockRestore();
  restoreFakeWebSocket();
});

/** 保留真实共享投影，模拟重新进入已有会话的页面。 */
function renderCachedChat() {
  const binding = createSessionDocBinding(createDeterministicRcsSessionId("env-1", "user-1", "inst-1"));
  const docRoot = binding.ydoc.getMap("root");
  docRoot.set(
    "session",
    new Y.Map<unknown>([
      ["sessionId", "ses-existing"],
      ["status", "ready"],
    ]),
  );
  docRoot.set("agent", new Y.Map([["capabilities", new Y.Map([["loadSession", true]])]]));
  docRoot.set("sessionListLoaded", true);
  const latest: { current: ChatPanelRuntime | null } = { current: null };
  function Probe() {
    const runtime = useChatPanelRuntime({
      agentId: "env-1",
      sessionId: "inst-1",
      authState: "ready",
      userId: "user-1",
      usePeriTaskViews,
    });
    latest.current = runtime;
    return runtime.connectionState === "connected"
      ? createElement(ACPMain, {
          ...runtime.callbacks,
          connectionState: runtime.connectionState,
          chatState: runtime.chatState,
          sessionState: runtime.sessionState,
          supportsLoadSession: true,
        })
      : null;
  }
  const root = createRoot(win.document.createElement("div") as unknown as HTMLElement);
  act(() => root.render(createElement(Probe)));
  const socket = legacySockets()[0];
  if (!socket) throw new Error("未建立动作连接");
  return {
    latest,
    socket,
    unmount() {
      act(() => root.unmount());
      binding.cleanup();
    },
  };
}

/** 单独触发物理连接，故意不合并服务端命令握手。 */
function openTransport(socket: FakeWebSocket) {
  act(() => {
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
  });
}

/** 命令代次使用现有协议帧，不依赖客户端运行时升级。 */
function completeHandshake(socket: FakeWebSocket, commandEpoch = epoch) {
  act(() =>
    socket.onmessage?.({ data: JSON.stringify({ type: "yjs:command-epoch", epoch: commandEpoch }) } as MessageEvent),
  );
}

/** 从真实传输出口读取命令，避免仅断言界面标志掩盖恢复命令丢失。 */
function actions(socket: FakeWebSocket) {
  return socket.sent
    .filter((frame): frame is string => typeof frame === "string")
    .map((frame) => JSON.parse(frame) as { action?: string; sessionId?: string; commandId?: string })
    .filter((frame) => frame.action);
}

// 有缓存且服务端握手晚于恢复防抖时，等待就绪后只恢复一次，不误报断线。
test("历史会话在命令握手就绪后恢复，延迟握手不弹发送失败", async () => {
  const harness = renderCachedChat();
  try {
    openTransport(harness.socket);
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.latest.current?.connectionState).toBe("connecting");
    expect(actions(harness.socket)).toEqual([]);
    expect(toastErrors).not.toHaveBeenCalled();

    completeHandshake(harness.socket);
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.latest.current?.connectionState).toBe("connected");
    const loads = actions(harness.socket).filter((frame) => frame.action === "load_session");
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({ sessionId: "ses-existing" });
    expect(loads[0]?.commandId?.startsWith(`${epoch}.`)).toBe(true);
    expect(toastErrors).not.toHaveBeenCalled();
  } finally {
    harness.unmount();
  }
});

// 连接握手前失败必须保留重连入口，迟到的代次不能把已关闭连接变成已连接。
test("握手期间终态断线保留错误状态且不恢复会话", () => {
  const harness = renderCachedChat();
  try {
    openTransport(harness.socket);
    act(() => harness.socket.closeFromServer(4500, "machine offline"));
    completeHandshake(harness.socket);
    expect(harness.latest.current?.connectionState).toBe("error");
    expect(actions(harness.socket)).toEqual([]);
    expect(toastErrors).not.toHaveBeenCalled();
  } finally {
    harness.unmount();
  }
});

// 重新进入必须等待新连接的代次；旧 socket 的迟到帧不能放行新连接或触发恢复。
test("重新进入等待新握手，并用新代次恢复一次历史会话", async () => {
  const harness = renderCachedChat();
  try {
    act(() => harness.socket.open());
    const initialLoads = actions(harness.socket).filter((frame) => frame.action === "load_session");
    expect(initialLoads).toHaveLength(1);
    act(() =>
      harness.socket.onmessage?.({
        data: JSON.stringify({
          type: "action_ack",
          commandId: initialLoads[0]?.commandId,
          status: "committed",
          sessionId: "ses-existing",
        }),
      } as MessageEvent),
    );
    act(() => harness.socket.closeFromServer(4002, "instance_stopped"));
    act(() =>
      win.dispatchEvent(
        new win.CustomEvent("agent:entered", {
          detail: { envId: "env-1", instanceUid: "inst-1" },
        }),
      ),
    );
    const reconnected = legacySockets().at(-1);
    if (!reconnected || reconnected === harness.socket) throw new Error("重新进入未建立新连接");
    openTransport(reconnected);
    completeHandshake(harness.socket);
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.latest.current?.connectionState).toBe("connecting");
    expect(actions(reconnected)).toEqual([]);
    expect(toastErrors).not.toHaveBeenCalled();

    const nextEpoch = "22222222-2222-4222-8222-222222222222";
    completeHandshake(reconnected, nextEpoch);
    await act(async () => {
      await Bun.sleep(350);
    });
    const loads = actions(reconnected).filter((frame) => frame.action === "load_session");
    expect(loads).toHaveLength(1);
    expect(loads[0]?.commandId?.startsWith(`${nextEpoch}.`)).toBe(true);
    expect(toastErrors).not.toHaveBeenCalled();
  } finally {
    harness.unmount();
  }
});
