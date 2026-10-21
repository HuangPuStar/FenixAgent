// 创建会话回执的浏览器侧接线：`onCreateSession()` 必须由**本次请求的 commandId** 定向结算。
//
// 该文件钉住的边界：accepted 不是回执（先于 Agent 结果到达）、别人的 commandId 不结算本请求
// （多标签页并发）、失败帧结算为「无回执」。共享投影里的 active session 变化在本层不可见，
// 因此「本页本次创建出了哪个会话」只能由这条定向 Ack 回答。

import { afterEach, describe, expect, test } from "bun:test";
import { createDeterministicRcsSessionId, createPublicError } from "@fenix/chat-channel";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import { PromptRecovery } from "../agent-panel/PromptRecovery";
import type { ChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { useChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { createSessionDocBinding } from "../yjs/doc-hub";

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
    const current = latest.current;
    return current.preservedPrompt
      ? createElement(PromptRecovery, {
          prompt: current.preservedPrompt,
          retry: current.retryPreservedPrompt,
          dismiss: current.dismissPreservedPrompt,
          disabled: false,
        })
      : null;
  }
  const container = win.document.createElement("div");
  const root = createRoot(container as unknown as HTMLElement);
  act(() => root.render(createElement(Probe)));
  return { latest, container, unmount: () => act(() => root.unmount()) };
}

/** 打开连接并返回 socket（hook 首帧即建连）。 */
function connect() {
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

/** 真实共享投影改变目标，运行时仍通过原 WebSocket 接收动作结果。 */
function setProjectedSession(sessionId: string) {
  const key = createDeterministicRcsSessionId("env-1", "user-1", "inst-1");
  const binding = createSessionDocBinding(key);
  act(() => {
    const root = binding.ydoc.getMap("root");
    const session = root.get("session");
    if (session instanceof Y.Map) session.set("sessionId", sessionId);
    else root.set("session", new Y.Map([["sessionId", sessionId]]));
  });
  binding.cleanup();
}

function lastPrompt(socket: FakeWebSocket): Record<string, unknown> {
  const frame = [...socket.sent]
    .reverse()
    .map((raw) => JSON.parse(raw) as Record<string, unknown>)
    .find((item) => item.action === "send_prompt");
  if (!frame) throw new Error("未找到发送输入");
  return frame;
}

describe("旧目标输入恢复", () => {
  // 已写入 socket 但回执丢失时必须可见保留且标记未知，不能把它作为确定失败重新发出。
  test("断线使未确认输入成为可见的未知结果草稿", () => {
    const { latest, socket, unmount, container } = connect();
    setProjectedSession("ses-a");
    const content = [{ type: "text", text: "等待确认的草稿 @./file.pdf" }];
    act(() => latest.current?.callbacks.onSendPrompt(content));
    const original = lastPrompt(socket);
    act(() => socket.close());
    expect(latest.current?.preservedPrompt).toMatchObject({ outcomeUnknown: true, content });
    expect(container.textContent).toContain("promptRecoveryUnknown");
    act(() => latest.current?.retryPreservedPrompt());
    expect(lastPrompt(socket).commandId).toBe(original.commandId);
    unmount();
  });

  // 收到会话冲突时保留完整输入，更新投影不会自动重投，用户确认后才发送到新目标。
  test("真实运行时保留文本图片和附件并显式重发到当前会话", () => {
    const { latest, socket, unmount, container } = connect();
    setProjectedSession("ses-a");
    const content = [
      { type: "text", text: "草稿 @./report.pdf" },
      { type: "image", mimeType: "image/png", data: "retained-image-data" },
    ];
    act(() => latest.current?.callbacks.onSendPrompt(content));
    const original = lastPrompt(socket);
    expect(original.sessionId).toBe("ses-a");
    setProjectedSession("ses-b");
    act(() =>
      socket.receiveFromServer({
        type: "action_error",
        commandId: original.commandId,
        error: createPublicError("ACTION.VERSION_CONFLICT"),
      }),
    );
    expect(latest.current?.preservedPrompt?.content).toEqual(content);
    expect(lastPrompt(socket).commandId).toBe(original.commandId);
    expect(container.textContent).toContain("promptRecoverySaved");
    act(() => container.querySelector("button")?.click());
    const retried = lastPrompt(socket);
    expect(retried.sessionId).toBe("ses-b");
    expect(retried.content).toEqual(content);
    expect(retried.commandId).not.toBe(original.commandId);
    act(() => socket.receiveFromServer({ type: "action_ack", commandId: retried.commandId, status: "committed" }));
    expect(latest.current?.preservedPrompt).toBeNull();
    unmount();
  });

  // 明确放弃旧未知输入意味着结束该意图；后续相同文本应有新身份而非永久被旧结果拦截。
  test("点击放弃未知草稿后相同文本发送获得新命令 ID", () => {
    const { latest, socket, unmount, container } = connect();
    setProjectedSession("ses-a");
    const content = [{ type: "text", text: "继续" }];
    act(() => latest.current?.callbacks.onSendPrompt(content));
    const original = lastPrompt(socket);
    act(() =>
      socket.receiveFromServer({
        type: "action_error",
        commandId: original.commandId,
        error: createPublicError("ACTION.OUTCOME_UNKNOWN"),
      }),
    );
    expect(latest.current?.preservedPrompt?.commandId).toBe(original.commandId);
    const dismiss = container.querySelector("button");
    expect(dismiss?.textContent).toBe("promptRecoveryDiscard");
    act(() => dismiss?.click());
    expect(latest.current?.preservedPrompt).toBeNull();
    act(() => latest.current?.callbacks.onSendPrompt(content));
    const current = lastPrompt(socket);
    expect(current.commandId).not.toBe(original.commandId);
    expect(current.content).toEqual(content);
    expect(current.sessionId).toBe("ses-a");
    unmount();
  });

  // 不确定结果不能显示可盲目重发的恢复动作，也不能释放幂等键后生成新的副作用。
  test("未知结果保留内容和原幂等键且恢复重发被禁止", () => {
    const { latest, socket, unmount, container } = connect();
    setProjectedSession("ses-a");
    const content = [{ type: "text", text: "不可重复执行" }];
    act(() => latest.current?.callbacks.onSendPrompt(content));
    const original = lastPrompt(socket);
    act(() =>
      socket.receiveFromServer({
        type: "action_error",
        commandId: original.commandId,
        error: createPublicError("ACTION.OUTCOME_UNKNOWN"),
      }),
    );
    expect(latest.current?.preservedPrompt).toMatchObject({ outcomeUnknown: true, content });
    expect(container.textContent).toContain("promptRecoveryUnknown");
    expect(container.querySelectorAll("button")).toHaveLength(1);
    act(() => latest.current?.retryPreservedPrompt());
    expect(lastPrompt(socket).commandId).toBe(original.commandId);
    act(() => latest.current?.callbacks.onSendPrompt(content));
    expect(lastPrompt(socket).commandId).toBe(original.commandId);
    unmount();
  });
});
