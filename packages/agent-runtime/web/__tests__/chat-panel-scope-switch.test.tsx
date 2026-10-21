// packages/agent-runtime/web/__tests__/chat-panel-scope-switch.test.tsx
// 真实 action + Doc 换代回归：create/load 的 scope 归属、epoch 归零后的复用与失败 create 消费。
// 与 create-session-receipt.test.tsx 的回执测试分开，避免单文件超出维护上限。

import { afterEach, describe, expect, test } from "bun:test";
import { createDeterministicRcsSessionId } from "@fenix/chat-channel";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import type { ChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { useChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import { replaceDocHubUpdate } from "../yjs/doc-hub";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;

/** 记录出站帧并支持服务端控制帧的 WebSocket 替身。 */
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

  open(withEpoch = true): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
    if (withEpoch) {
      this.receiveFromServer({ type: "yjs:command-epoch", epoch: "11111111-1111-4111-8111-111111111111" });
    }
  }

  send(data: string): void {
    this.sent.push(data);
  }

  receiveFromServer(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
}

const originalWebSocket = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");

/** Peri Task 视图由宿主注入；本文件只关心换代归属。 */
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

function connect(withEpoch = true) {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: FakeWebSocket });
  const harness = renderRuntime();
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error("hook 未建立 WebSocket 连接");
  act(() => socket.open(withEpoch));
  return { ...harness, socket };
}

function lastCreateCommandId(socket: FakeWebSocket): string {
  for (const raw of [...socket.sent].reverse()) {
    const frame = JSON.parse(raw) as Record<string, unknown>;
    if (frame.action !== "create_session") continue;
    const commandId = frame.commandId;
    if (typeof commandId === "string") return commandId;
  }
  throw new Error("未找到 create_session 出站帧");
}

/** 空的 Chat Doc 换代帧：时间线为空，只用于触发投影换代。 */
function emptyChatUpdate(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/** Session Doc 换代帧：只写门控需要的 replayState，缺省表示新 Doc 尚未回放。 */
function sessionReplayUpdate(replayState: "complete" | null): Uint8Array {
  const doc = new Y.Doc();
  const session = new Y.Map<unknown>();
  doc.getMap("root").set("session", session);
  if (replayState !== null) session.set("replayState", replayState);
  return Y.encodeStateAsUpdate(doc);
}

/** 成对提交 Chat/Session Doc，模拟服务端一次真实的 load/create 换代。 */
let projectionGeneration = 0;
function replaceProjection(replayState: "complete" | null) {
  const key = createDeterministicRcsSessionId("env-1", "user-1", "inst-1");
  projectionGeneration += 1;
  const generation = `test-generation-${projectionGeneration}`;
  replaceDocHubUpdate(key, `chat:${key}`, generation, emptyChatUpdate());
  replaceDocHubUpdate(key, `session:${key}`, generation, sessionReplayUpdate(replayState));
}

afterEach(() => {
  if (originalWebSocket) {
    Object.defineProperty(globalThis, "WebSocket", originalWebSocket);
  } else {
    Reflect.deleteProperty(globalThis, "WebSocket");
  }
});

describe("local create 的换代归属", () => {
  // 本标签 create 后另一标签触发 load：localCreate 只属于上一次换代，
  // 远端 load 首帧必须 loading，不能复用新建会话的空态抑制。
  test("远端 load 换代不沿用本地 create 空态", async () => {
    const { latest, unmount } = connect();
    act(() => replaceProjection("complete"));
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    // 本标签 create：空态直出。
    act(() => {
      void latest.current?.callbacks.onCreateSession();
      replaceProjection(null);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    // 另一标签的远端 load 换代：必须重新挂 loading，且 250ms 内不得空提交。
    act(() => replaceProjection(null));
    expect(latest.current?.sessionState.loading).not.toBeNull();
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).not.toBeNull();
    unmount();
  }, 30_000);

  // 真实 action 序列 create→load→create（epoch 1→0→1）：第二次 create 必须重新绑定新 scope，
  // 不得复用第一次 create 的绑定而被当成 load 等待 1.75s。
  test("create→load→create 重新绑定而非复用旧 epoch", async () => {
    const { latest, unmount } = connect();
    act(() => replaceProjection("complete"));
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    // 第一次 create → 空态直出。
    act(() => {
      void latest.current?.callbacks.onCreateSession();
      replaceProjection(null);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    // 真实 load：epoch 归零并清除旧 create 绑定。
    act(() => {
      latest.current?.callbacks.onLoadSession("ses-other");
      replaceProjection(null);
    });
    expect(latest.current?.sessionState.loading).not.toBeNull();

    // 第二次 create：epoch 复用 1，但绑定已清空，必须空态直出并在 settle 后完成。
    act(() => {
      void latest.current?.callbacks.onCreateSession();
      replaceProjection(null);
    });
    expect(latest.current?.sessionState.loading).toBeNull();
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();
    unmount();
  }, 30_000);

  // load 请求尚未产生换代时再次 create：create 动作本身必须清除旧绑定，避免 epoch 复用。
  test("load 未换代就再次 create 也不复用旧绑定", async () => {
    const { latest, unmount } = connect();
    act(() => replaceProjection("complete"));
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    // 第一次 create → 绑定当前 scope。
    act(() => {
      void latest.current?.callbacks.onCreateSession();
      replaceProjection(null);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    // 只发出 load 请求，不产生换代；旧绑定必须由 create 动作清除。
    act(() => latest.current?.callbacks.onLoadSession("ses-pending"));
    expect(latest.current?.sessionState.loading).toBeNull();

    // 第二次 create：epoch 归零后复用 1，但必须重新绑定新 scope。
    act(() => {
      void latest.current?.callbacks.onCreateSession();
      replaceProjection(null);
    });
    expect(latest.current?.sessionState.loading).toBeNull();
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();
    unmount();
  }, 30_000);

  // 连接丢失后 create 回执不会到达：必须撤销归属，重连后的远端 load 不得被当成新建。
  test("连接丢失后失败的 create 不消费后续远端 load", async () => {
    const { latest, socket, unmount } = connect();
    act(() => replaceProjection("complete"));
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    act(() => {
      void latest.current?.callbacks.onCreateSession();
    });
    act(() => socket.close());

    act(() => replaceProjection(null));
    expect(latest.current?.sessionState.loading).not.toBeNull();
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).not.toBeNull();
    unmount();
  }, 30_000);

  // commandId 分配失败（代次未就绪）也属于未确认 create：撤销归属，后续远端 load 首帧必须 loading。
  test("commandId 分配失败的 create 不消费后续远端 load", async () => {
    const { latest, socket, unmount } = connect(false);
    act(() => replaceProjection("complete"));
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    const creating = latest.current?.callbacks.onCreateSession();
    expect(await creating).toBeNull();
    expect(socket.sent.some((raw) => (JSON.parse(raw) as Record<string, unknown>).action === "create_session")).toBe(
      false,
    );

    act(() => replaceProjection(null));
    expect(latest.current?.sessionState.loading).not.toBeNull();
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).not.toBeNull();
    unmount();
  }, 30_000);

  // create 失败回执必须撤销归属：后续远端 load 不得被当成刚创建的会话而空态直出。
  test("失败的 create 不消费后续远端 load", async () => {
    const { latest, socket, unmount } = connect();
    act(() => replaceProjection("complete"));
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

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
    expect(latest.current?.sessionState.loading).toBeNull();

    // 失败后另一标签触发 load：首帧必须 loading，不能复用已失败的 create 归属。
    act(() => replaceProjection(null));
    expect(latest.current?.sessionState.loading).not.toBeNull();
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).not.toBeNull();
    unmount();
  }, 30_000);

  // 切离零历史 complete 会话：旧 replayState=complete 不得在新 scope 首帧抑制 loading。
  test("切离 complete 会话首帧不沿用 noReplaySession", async () => {
    const { latest, unmount } = connect();
    act(() => replaceProjection("complete"));
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).toBeNull();

    act(() => replaceProjection(null));
    expect(latest.current?.sessionState.loading).not.toBeNull();
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(latest.current?.sessionState.loading).not.toBeNull();
    unmount();
  }, 30_000);
});
