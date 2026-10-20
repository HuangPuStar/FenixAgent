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
import { encodeYjsUpdateFrame } from "@fenix/chat-channel";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
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

function isSyncSocket(socket: FakeWebSocket): boolean {
  return socket.url.includes("chatSync=1");
}

function legacySockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((socket) => !isSyncSocket(socket));
}

function syncSockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter(isSyncSocket);
}

/** 新协议 ERROR 帧（UTF-8 JSON 二进制）用于触发同步终态回退。 */
function syncErrorFrame(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      type: "ERROR",
      protocolVersion: 1,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      retryable: false,
      message: "unsupported version",
    }),
  );
}

/** 旧通道的 yjs update 二进制帧：模拟缺失文档在重试连接上重新交付。 */
function legacyUpdateFrame(docName: string): Uint8Array {
  const doc = new Y.Doc();
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return encodeYjsUpdateFrame(docName, update);
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

  // 历史快照未送达时暴露缺失文档；重试期间保持门禁，直到缺失文档重新交付才解除。
  test("历史同步未完成：重试保持缺失状态并在快照到达后解除", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.onmessage?.({
        data: JSON.stringify({
          type: "yjs:history-incomplete",
          docs: ["chat:rcs-1"],
          reason: "too_large",
          bytes: 9_440_845,
          limitBytes: 8 * 1024 * 1024,
        }),
      } as MessageEvent);
    });
    expect(harness.latest.current?.historyRecovery?.docs).toEqual(["chat:rcs-1"]);
    expect(harness.latest.current?.historyRecovery?.bytes).toBe(9_440_845);

    act(() => harness.latest.current?.retryHistoryRecovery());
    // 重试只重建连接，不能提前清空历史缺失状态或解除上方发送门禁。
    expect(harness.latest.current?.historyRecovery?.docs).toEqual(["chat:rcs-1"]);
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const retrySocket = FakeWebSocket.instances[1];
    act(() => retrySocket?.open());
    expect(harness.latest.current?.historyRecovery).not.toBeNull();

    // 本次重试未拿到快照就断开：重试入口必须恢复可用，历史缺失状态不能解除。
    act(() => retrySocket?.closeFromServer(1006, "connection_lost"));
    expect(harness.latest.current?.historyRecovery).not.toBeNull();
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(false);

    act(() => harness.latest.current?.retryHistoryRecovery());
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(3);
    const secondRetrySocket = FakeWebSocket.instances[2];
    act(() => secondRetrySocket?.open());

    act(() => {
      secondRetrySocket?.onmessage?.({ data: legacyUpdateFrame("chat:rcs-1") } as MessageEvent);
    });
    expect(harness.latest.current?.historyRecovery).toBeNull();
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(false);

    harness.unmount();
  });

  // 同步回退 + 旧历史缺失时发送被阻止；重试未完成前门禁保持，缺失文档重新交付后才放开。
  test("历史恢复重试期间保持发送门禁，完整快照到达后解除", () => {
    installFakeWebSocket();
    const storage = win.localStorage;
    const hadLocalStorage = Object.hasOwn(globalThis, "localStorage");
    runtimeGlobal.localStorage = storage;
    storage.setItem("active_org_id", "org-1");
    const harness = renderRuntime();
    try {
      const legacy = legacySockets()[0];
      const sync = syncSockets()[0];
      expect(legacy).toBeDefined();
      expect(sync).toBeDefined();

      act(() => {
        legacy?.onmessage?.({
          data: JSON.stringify({
            type: "yjs:history-incomplete",
            docs: ["chat:rcs-1"],
            reason: "backpressure",
            bytes: 0,
            limitBytes: 8 * 1024 * 1024,
          }),
        } as MessageEvent);
      });
      act(() => sync?.open());
      act(() => {
        sync?.onmessage?.({ data: syncErrorFrame() } as MessageEvent);
      });
      expect(harness.latest.current?.syncChat.legacyFallback).toBe(true);
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);

      act(() => harness.latest.current?.retryHistoryRecovery());
      expect(harness.latest.current?.historyRecovery).not.toBeNull();
      expect(harness.latest.current?.historyRecoveryRetrying).toBe(true);
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);
      expect(legacySockets()).toHaveLength(2);

      const retrySocket = legacySockets()[1];
      act(() => retrySocket?.open());
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);

      act(() => {
        retrySocket?.onmessage?.({ data: legacyUpdateFrame("chat:rcs-1") } as MessageEvent);
      });
      expect(harness.latest.current?.historyRecovery).toBeNull();
      expect(harness.latest.current?.historyRecoveryRetrying).toBe(false);
      expect(harness.latest.current?.syncDegradedBlocked).toBe(false);
    } finally {
      storage.removeItem("active_org_id");
      if (!hadLocalStorage) Reflect.deleteProperty(runtimeGlobal, "localStorage");
      harness.unmount();
    }
  });
});
