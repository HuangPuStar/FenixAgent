// 用户主动停止实例后的客户端处置（AOS-BUG-002 的客户端半边）。
//
// 服务端停止实例时以 4002 `instance_stopped` 断开该实例的 chat 连接（`closeRelayConnectionsForStoppedInstance`），
// 并把停止意图记在 coordinator 上直到显式 restart。修复前 4002 不在关闭码策略表里，客户端按「非终态」
// 退避重连一次，撞上服务端的 `INSTANCE_STOPPED` → 4502 spawn_rejected + 公开错误
// `CONTROL_PLANE.INSTANCE_START_FAILED`，于是用户主动停止被报成「Agent 实例启动失败。」，整屏红色错误卡。
//
// 本文件渲染真实 hook（FakeWebSocket 顶替全局 WebSocket，不做模块 mock），钉住两件事：
//   ① 终态关闭不再置 `autoReconnecting`（不得谎报「正在自动重连」）；
//   ② 终态语义经 `terminalUiCode` 交给渲染层，且不被后续非终态断开残留污染。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { useChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;

/** 最小 WebSocket 替身：只需支撑建连、服务端关闭与「有没有再建一条连接」的断言。 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code: 1000, reason: "client_disconnect" } as CloseEvent);
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  closeFromServer(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  send(): void {}
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

/** Peri Task 视图由宿主注入；本文件只关心连接状态机，桩恒为空。 */
const usePeriTaskViews = () => ({ state: { tasks: [], loaded: true } });

function renderRuntime() {
  const latest: { current: ChatPanelRuntime | null } = { current: null };
  function Probe() {
    latest.current = useChatPanelRuntime({
      agentId: "env-1",
      sessionId: "inst-1",
      authState: "ready",
      userId: "user-1",
      usePeriTaskViews,
    });
    return null;
  }
  const container = win.document.createElement("div");
  const root = createRoot(container as unknown as HTMLElement);
  act(() => root.render(createElement(Probe)));
  return { latest, unmount: () => act(() => root.unmount()) };
}

function installFakeWebSocket(): void {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
}

afterEach(() => {
  if (originalWebSocket) {
    Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

describe("useChatPanelRuntime 主动停止实例", () => {
  // 4002 是用户主动停止的预期终态：停止自动重连，并把「实例已停止」交给渲染层，不再产生错误卡。
  test("4002 终态：不自动重连，terminalUiCode 为 instance_stopped", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => socket?.open());
    expect(harness.latest.current?.connectionState).toBe("connected");

    act(() => socket?.closeFromServer(4002, "instance_stopped"));

    expect(harness.latest.current?.autoReconnecting).toBe(false);
    expect(harness.latest.current?.terminalUiCode).toBe("instance_stopped");
    expect(harness.latest.current?.connectionState).toBe("error");
    // 策略表判定 stopReconnect：客户端不得再建一条连接（修复前这里会出现第二条 socket）。
    expect(FakeWebSocket.instances).toHaveLength(1);

    harness.unmount();
  });

  // 非终态断开（网络抖动）仍走自动重连轻提示，且不得留下上一次的终态语义。
  test("1006 非终态：自动重连标记为真，终态语义被清空", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    const socket = FakeWebSocket.instances[0];
    act(() => socket?.open());

    act(() => socket?.closeFromServer(1006, "connection_lost"));

    expect(harness.latest.current?.autoReconnecting).toBe(true);
    expect(harness.latest.current?.terminalUiCode).toBeNull();
    expect(harness.latest.current?.connectionState).toBe("disconnected");

    // 卸载触发 disconnect()，清掉退避重连定时器，避免测试结束后再建连接。
    harness.unmount();
  });
});
