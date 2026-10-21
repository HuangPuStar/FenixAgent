import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChatPanelRuntime } from "../../agent-panel/use-chat-panel-runtime";
import { useChatPanelRuntime } from "../../agent-panel/use-chat-panel-runtime";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

export const win = initializeHappyDomWindow(new Window());
export const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;

/** 最小 WebSocket 替身：只需支撑建连、服务端关闭与「有没有再建一条连接」的断言。 */
export class FakeWebSocket {
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
    this.onmessage?.({
      data: JSON.stringify({ type: "yjs:command-epoch", epoch: "11111111-1111-4111-8111-111111111111" }),
    } as MessageEvent);
  }

  closeFromServer(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  readonly sent: Array<string | ArrayBuffer> = [];
  send(data: string | ArrayBuffer): void {
    this.sent.push(data);
  }
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

/** Peri Task 视图由宿主注入；本文件只关心连接状态机，桩恒为空。 */
const usePeriTaskViews = () => ({ state: { tasks: [], loaded: true } });

/** 使用真实 hook 观察状态与动作，避免模块替身掩盖协议接线。 */
export function renderRuntime() {
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

/** 每个用例重新安装传输替身，隔离连接实例与浏览器上下文。 */
export function installFakeWebSocket(): void {
  runtimeGlobal.window = win;
  runtimeGlobal.document = win.document;
  runtimeGlobal.navigator = win.navigator;
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
}

/** 同一页面同时维护动作连接与新协议同步连接。 */
export function isSyncSocket(socket: FakeWebSocket): boolean {
  return socket.url.includes("chatSync=1");
}

/** 返回承载动作与旧 Doc 的连接，用于核对回退后的实际出口。 */
export function legacySockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((socket) => !isSyncSocket(socket));
}

/** 返回新同步连接，供测试触发真实协议降级。 */
export function syncSockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter(isSyncSocket);
}

/** 新协议 ERROR 帧（UTF-8 JSON 二进制）用于触发同步终态回退。 */
export function syncErrorFrame(): Uint8Array {
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

/** 还原全局 WebSocket，避免影响其他浏览器集成回归。 */
export function restoreFakeWebSocket(): void {
  if (originalWebSocket) {
    Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocket");
  }
}
