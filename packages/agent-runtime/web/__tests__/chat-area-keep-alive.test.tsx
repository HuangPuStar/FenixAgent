import { afterEach, describe, expect, test } from "bun:test";
import { encodeYjsUpdateFrame } from "@fenix/chat-channel";
import { ChatPageVisibleContext } from "@fenix/web-runtime/hooks/use-page-visible";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import * as Y from "yjs";
import { useChatAreaSlots } from "../agent-panel/chat-area-lifecycle";
import { type ChatPanelRuntime, useChatPanelRuntime } from "../agent-panel/use-chat-panel-runtime";
import {
  FakeWebSocket,
  installFakeWebSocket,
  legacySockets,
  restoreFakeWebSocket,
  syncSockets,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

const i18n = createInstance();
await i18n.init({ lng: "zh", resources: {} });
const usePeriTaskViews = () => ({ state: { tasks: [], loaded: true } });

/** 只替换浏览器 socket；缓存生命周期、可见性和连接 hook 都使用生产实现。 */
function renderCache() {
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container as unknown as HTMLElement);
  const runtimes = new Map<string, ChatPanelRuntime>();
  let options = {
    agentId: "env-a",
    sessionId: "inst-a",
    ownerKey: "org-1:user-1",
    deleted: new Set<string>(),
  };
  function Panel({ agentId, sessionId }: { agentId: string; sessionId: string | null }) {
    const runtime = useChatPanelRuntime({ agentId, sessionId, authState: "ready", userId: "user-1", usePeriTaskViews });
    runtimes.set(sessionId!, runtime);
    return (
      <section data-instance={sessionId}>
        <input aria-label="draft" />
        <div data-scroll="history" />
      </section>
    );
  }
  function Cache() {
    const { slots } = useChatAreaSlots(options.agentId, options.sessionId, options.ownerKey, options.deleted);
    return slots.map((slot) => (
      <ChatPageVisibleContext.Provider key={slot.key} value={slot.active}>
        <div hidden={!slot.active}>
          <Panel agentId={slot.agentId} sessionId={slot.sessionId} />
        </div>
      </ChatPageVisibleContext.Provider>
    ));
  }
  const render = (next: Partial<typeof options> = {}) => {
    options = { ...options, ...next };
    act(() =>
      root.render(
        <I18nextProvider i18n={i18n}>
          <Cache />
        </I18nextProvider>,
      ),
    );
  };
  render();
  return {
    render,
    runtimes,
    panel: (id: string) => container.querySelector(`[data-instance="${id}"]`),
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

/** 真实 Session Doc 帧让动作绑定到对应实例的 ACP 会话。 */
async function bindSession(socket: FakeWebSocket, rcsSessionKey: string, sessionId: string) {
  const doc = new Y.Doc();
  doc.getMap("root").set("session", new Y.Map([["sessionId", sessionId]]));
  await act(async () => {
    socket.open();
    socket.onmessage?.({
      data: encodeYjsUpdateFrame(`session:${rcsSessionKey}`, "generation-1", Y.encodeStateAsUpdate(doc)),
    } as MessageEvent);
    await Bun.sleep(30);
  });
  doc.destroy();
}

describe("ChatArea 实例缓存", () => {
  // enter 恢复运行态后应重连已终止的目标连接，不能要求刷新或丢掉缓存草稿。
  test("机器不可用后 enter 成功恢复目标连接并保留面板", async () => {
    installFakeWebSocket();
    const h = renderCache();
    try {
      const socketA = legacySockets()[0]!;
      const panelA = h.panel("inst-a")!;
      panelA.querySelector("input")!.value = "恢复前草稿";
      act(() => socketA.closeFromServer(4500, "machine_unavailable"));
      h.render({ sessionId: "inst-b" });
      const socketB = legacySockets()[1]!;
      act(() =>
        win.dispatchEvent(
          new win.CustomEvent("agent:entered", {
            detail: { envId: "env-other", instanceUid: "inst-a" },
          }),
        ),
      );
      expect(legacySockets()).toHaveLength(2);
      act(() => {
        for (let i = 0; i < 2; i++)
          win.dispatchEvent(
            new win.CustomEvent("agent:entered", {
              detail: { envId: "env-a", instanceUid: "inst-a" },
            }),
          );
      });
      expect(legacySockets()).toHaveLength(3);
      const recovered = legacySockets()[2]!;
      expect(socketB.readyState).toBe(FakeWebSocket.CONNECTING);
      expect(h.panel("inst-a")).toBe(panelA);
      expect(panelA.querySelector("input")!.value).toBe("恢复前草稿");
      await bindSession(recovered, h.runtimes.get("inst-a")!.rcsSessionKey!, "ses-recovered");
      expect(h.runtimes.get("inst-a")!.connectionState).toBe("connected");
      expect(h.runtimes.get("inst-a")!.terminalUiCode).toBeNull();
      act(() => h.runtimes.get("inst-a")!.callbacks.onCancel());
      expect(JSON.parse(String(recovered.sent.at(-1)))).toMatchObject({ action: "cancel", sessionId: "ses-recovered" });
    } finally {
      h.unmount();
    }
  });

  // 重复进入正常实例不得打断连接或重建面板；在途连接也不能重复创建。
  test("enter 通知保留已连接和连接中的实例", async () => {
    installFakeWebSocket();
    const h = renderCache();
    try {
      const panel = h.panel("inst-a");
      const enter = () =>
        act(() =>
          win.dispatchEvent(
            new win.CustomEvent("agent:entered", {
              detail: { envId: "env-a", instanceUid: "inst-a" },
            }),
          ),
        );
      enter();
      expect(legacySockets()).toHaveLength(1);
      await bindSession(legacySockets()[0]!, h.runtimes.get("inst-a")!.rcsSessionKey!, "ses-a");
      enter();
      expect(legacySockets()).toHaveLength(1);
      expect(h.panel("inst-a")).toBe(panel);
      expect(h.runtimes.get("inst-a")!.connectionState).toBe("connected");
    } finally {
      h.unmount();
    }
  });

  // 动作通道恢复时，同步通道也必须重新握手，避免新回复仍被失效投影拦住。
  test("enter 同时恢复已终止的同步连接", () => {
    installFakeWebSocket();
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: win.localStorage });
    win.localStorage.setItem("active_org_id", "org-1");
    const h = renderCache();
    try {
      expect(syncSockets()).toHaveLength(1);
      act(() => {
        legacySockets()[0]!.closeFromServer(4500, "machine_unavailable");
        syncSockets()[0]!.closeFromServer(4500, "machine_unavailable");
      });
      act(() =>
        win.dispatchEvent(
          new win.CustomEvent("agent:entered", {
            detail: { envId: "env-a", instanceUid: "inst-a" },
          }),
        ),
      );
      expect(legacySockets()).toHaveLength(2);
      expect(syncSockets()).toHaveLength(2);
      expect(syncSockets()[1]!.readyState).toBe(FakeWebSocket.CONNECTING);
    } finally {
      h.unmount();
      win.localStorage.removeItem("active_org_id");
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  // 来回切换必须保留原 DOM、草稿和滚动位置，两实例继续通过各自的连接发送动作。
  test("A → B → A 保留面板和连接，动作不串会话", async () => {
    installFakeWebSocket();
    const h = renderCache();
    try {
      const socketA = legacySockets()[0]!;
      const panelA = h.panel("inst-a")!;
      panelA.querySelector("input")!.value = "实例 A 的草稿";
      panelA.querySelector("div")!.scrollTop = 120;
      await bindSession(socketA, h.runtimes.get("inst-a")!.rcsSessionKey!, "ses-a");
      h.render({ sessionId: "inst-b" });
      const socketB = legacySockets()[1]!;
      const panelB = h.panel("inst-b")!;
      panelB.querySelector("input")!.value = "实例 B 的草稿";
      await bindSession(socketB, h.runtimes.get("inst-b")!.rcsSessionKey!, "ses-b");
      expect(h.runtimes.get("inst-a")!.rcsSessionKey).not.toBe(h.runtimes.get("inst-b")!.rcsSessionKey);

      h.render({ sessionId: "inst-a" });
      expect(h.panel("inst-a")).toBe(panelA);
      expect(h.panel("inst-b")).toBe(panelB);
      expect(panelA.querySelector("input")!.value).toBe("实例 A 的草稿");
      expect(panelB.querySelector("input")!.value).toBe("实例 B 的草稿");
      expect(panelA.querySelector("div")!.scrollTop).toBe(120);
      expect(legacySockets()).toHaveLength(2);
      expect(socketA.readyState).toBe(FakeWebSocket.OPEN);
      expect(socketB.readyState).toBe(FakeWebSocket.OPEN);
      act(() => {
        h.runtimes.get("inst-a")!.callbacks.onCancel();
        h.runtimes.get("inst-b")!.callbacks.onCancel();
      });
      expect(JSON.parse(String(socketA.sent.at(-1)))).toMatchObject({ action: "cancel", sessionId: "ses-a" });
      expect(JSON.parse(String(socketB.sent.at(-1)))).toMatchObject({ action: "cancel", sessionId: "ses-b" });
    } finally {
      h.unmount();
    }
  });

  // 重启后台实例不能使同 Agent 的当前实例丢失草稿或重建连接。
  test("单实例重启只重建目标面板", () => {
    installFakeWebSocket();
    const h = renderCache();
    try {
      const socketA = legacySockets()[0]!;
      h.render({ sessionId: "inst-b" });
      const socketB = legacySockets()[1]!;
      const panelB = h.panel("inst-b");
      act(() =>
        win.dispatchEvent(
          new win.CustomEvent("agent:reconnect", {
            detail: { envId: "env-a", instanceUid: "inst-a" },
          }),
        ),
      );
      expect(socketA.readyState).toBe(FakeWebSocket.CLOSED);
      expect(socketB.readyState).toBe(FakeWebSocket.CONNECTING);
      expect(h.panel("inst-b")).toBe(panelB);
      expect(legacySockets()).toHaveLength(3);
      h.render({ sessionId: "inst-a" });
      expect(legacySockets()).toHaveLength(3);
    } finally {
      h.unmount();
    }
  });

  // 删除 Agent 后所有对应实例立即退出，其他环境的缓存继续保留。
  test("删除环境释放其缓存且不会因旧路由回填", () => {
    installFakeWebSocket();
    const h = renderCache();
    try {
      const socketA = legacySockets()[0]!;
      h.render({ agentId: "env-b", sessionId: "inst-b" });
      const panelB = h.panel("inst-b");
      h.render({ deleted: new Set(["env-a"]) });
      expect(socketA.readyState).toBe(FakeWebSocket.CLOSED);
      expect(h.panel("inst-a")).toBeNull();
      expect(h.panel("inst-b")).toBe(panelB);
      h.render({ agentId: "env-a", sessionId: "inst-a" });
      expect(h.panel("inst-a")).toBeNull();
      expect(legacySockets()).toHaveLength(2);
    } finally {
      h.unmount();
    }
  });

  // 组织或用户变化必须当帧隔离旧缓存，不能保留旧身份的连接和草稿。
  test("缓存属主变化释放全部旧面板", () => {
    installFakeWebSocket();
    const h = renderCache();
    try {
      h.panel("inst-a")!.querySelector("input")!.value = "旧组织草稿";
      h.render({ sessionId: "inst-b" });
      const oldSockets = [...legacySockets()];
      h.render({ ownerKey: "org-2:user-1" });
      expect(oldSockets.every((socket) => socket.readyState === FakeWebSocket.CLOSED)).toBe(true);
      expect(h.panel("inst-a")).toBeNull();
      h.render({ sessionId: "inst-a" });
      expect(h.panel("inst-a")!.querySelector("input")!.value).toBe("");
      expect(legacySockets()).toHaveLength(4);
    } finally {
      h.unmount();
    }
  });

  // 宿主退出时清理所有曾访问实例，避免缓存留下后台连接。
  test("宿主卸载释放所有缓存连接", () => {
    installFakeWebSocket();
    const h = renderCache();
    h.render({ sessionId: "inst-b" });
    const sockets = [...legacySockets()];
    h.unmount();
    expect(sockets).toHaveLength(2);
    expect(sockets.every((socket) => socket.readyState === FakeWebSocket.CLOSED)).toBe(true);
  });
});
