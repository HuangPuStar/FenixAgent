// 创建会话回执的浏览器侧接线：`onCreateSession()` 必须由**本次请求的 commandId** 定向结算。
//
// 该文件钉住的边界：accepted 不是回执（先于 Agent 结果到达）、别人的 commandId 不结算本请求
// （多标签页并发）、失败帧结算为「无回执」。共享投影里的 active session 变化在本层不可见，
// 因此「本页本次创建出了哪个会话」只能由这条定向 Ack 回答。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { ChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { useChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;

/** 记录出站帧的 WebSocket 替身：回执断言需要读到本次请求的 commandId。 */
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
  readonly sent: string[] = [];

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

  send(data: string): void {
    this.sent.push(data);
  }

  /** 服务端帧（action_ack / action_error 等控制帧走文本帧）。 */
  receiveFromServer(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

/** Peri Task 视图由宿主注入；本文件只关心 create_session 回执。 */
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

/** 打开连接并返回 socket（hook 首帧即建连）。 */
function connect(): { latest: { current: ChatPanelRuntime | null }; unmount: () => void; socket: FakeWebSocket } {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  const harness = renderRuntime();
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error("hook 未建立 WebSocket 连接");
  act(() => socket.open());
  return { ...harness, socket };
}

/** 取最近一条 create_session 出站帧的 commandId。 */
function lastCreateCommandId(socket: FakeWebSocket): string {
  for (const raw of [...socket.sent].reverse()) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.action !== "create_session") continue;
    const commandId = frame.commandId;
    if (typeof commandId === "string") return commandId;
  }
  throw new Error("未找到 create_session 出站帧");
}

/** 在有限时间内观察 promise 是否落定（用于断言「accepted 不能结算」）。 */
async function settleWithin(promise: Promise<unknown>, ms: number): Promise<unknown | "pending"> {
  return Promise.race([promise, Bun.sleep(ms).then(() => "pending" as const)]);
}

afterEach(() => {
  if (originalWebSocket) {
    Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

describe("onCreateSession 创建回执", () => {
  // 正常路径：committed Ack 携带 sessionId → 调用方拿到本次创建出的会话标识。
  test("committed Ack 的 sessionId 结算为回执", async () => {
    const { latest, socket, unmount } = connect();
    const creating = latest.current?.callbacks.onCreateSession();
    expect(creating).toBeDefined();
    const commandId = lastCreateCommandId(socket);

    act(() => socket.receiveFromServer({ type: "action_ack", commandId, status: "accepted" }));
    expect(await settleWithin(creating, 20)).toBe("pending");

    act(() => socket.receiveFromServer({ type: "action_ack", commandId, status: "committed", sessionId: "ses-new" }));
    expect(await creating).toBe("ses-new");
    unmount();
  });

  // 区分度核心：别的 commandId（另一标签页的创建）不得结算本请求的等待者。
  test("其它 commandId 的回执不结算本请求", async () => {
    const { latest, socket, unmount } = connect();
    const creating = latest.current?.callbacks.onCreateSession();
    const commandId = lastCreateCommandId(socket);

    act(() =>
      socket.receiveFromServer({
        type: "action_ack",
        commandId: "other-tab",
        status: "committed",
        sessionId: "ses-other",
      }),
    );
    expect(await settleWithin(creating, 20)).toBe("pending");

    act(() => socket.receiveFromServer({ type: "action_ack", commandId, status: "committed", sessionId: "ses-mine" }));
    expect(await creating).toBe("ses-mine");
    unmount();
  });

  // 失败帧（服务端分类拒绝）结算为「无回执」，调用方据此不写归属而不是永久等待。
  test("action_error 结算为无回执", async () => {
    const { latest, socket, unmount } = connect();
    const creating = latest.current?.callbacks.onCreateSession();
    const commandId = lastCreateCommandId(socket);

    act(() =>
      socket.receiveFromServer({
        type: "action_error",
        commandId,
        error: { type: "ACTION.FAILED", id: "err_00000000000000000000000000000001", message: "The action failed." },
      }),
    );
    expect(await creating).toBeNull();
    unmount();
  });

  // 每次新建都必须带自己的 commandId：复用会让服务端去重表把第二次创建当成重发。
  test("两次创建使用不同的 commandId", async () => {
    const { latest, socket, unmount } = connect();
    const first = latest.current?.callbacks.onCreateSession();
    const firstCommandId = lastCreateCommandId(socket);
    act(() =>
      socket.receiveFromServer({
        type: "action_ack",
        commandId: firstCommandId,
        status: "committed",
        sessionId: "ses-1",
      }),
    );
    expect(await first).toBe("ses-1");

    const second = latest.current?.callbacks.onCreateSession();
    act(() =>
      socket.receiveFromServer({
        type: "action_ack",
        commandId: lastCreateCommandId(socket),
        status: "committed",
        sessionId: "ses-2",
      }),
    );
    expect(await second).toBe("ses-2");
    expect(lastCreateCommandId(socket)).not.toBe(firstCommandId);
    unmount();
  });
});
