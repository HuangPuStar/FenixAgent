// apps/web/src/__tests__/use-sync-chat-state.test.tsx
// 新同步前端开关与 hook 生命周期：默认开启、明确拒绝回退、切换与卸载释放连接。
// 用真实 hook + happy-dom 渲染（FakeSocket 顶替 socketFactory），不 mock 模块。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { type SyncChatState, useSyncChatState } from "../../../../packages/agent-runtime/web/hooks/use-sync-chat-state";
import type { SyncBrowserSocket } from "../../../../packages/agent-runtime/web/yjs/yjs-ws";
import {
  buildSyncChatSocketUrl,
  readSyncChatContentDocIds,
  readSyncChatSwitch,
} from "../../../../packages/agent-runtime/web/yjs/yjs-ws";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;

class FakeSocket implements SyncBrowserSocket {
  static instances: FakeSocket[] = [];

  binaryType = "arraybuffer";
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: unknown) => void) | null = null;
  onclose: ((code: number, reason: string) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closed.push({ code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

const disabledFactory = (): SyncBrowserSocket => {
  throw new Error("disabled hook must not open a socket");
};

const enabledFactory = (url: string): SyncBrowserSocket => new FakeSocket(url);

function renderHook(options: Parameters<typeof useSyncChatState>[0]): {
  latest: { current: SyncChatState | null };
  unmount: () => void;
  rerender: (next: Parameters<typeof useSyncChatState>[0]) => void;
} {
  let currentOptions = options;
  const latest: { current: SyncChatState | null } = { current: null };
  function Probe() {
    latest.current = useSyncChatState(currentOptions);
    return null;
  }
  const container = win.document.createElement("div");
  const root = createRoot(container as unknown as HTMLElement);
  act(() => root.render(createElement(Probe)));
  return {
    latest,
    unmount: () => act(() => root.unmount()),
    rerender: (next) => {
      currentOptions = next;
      act(() => root.render(createElement(Probe)));
    },
  };
}

afterEach(() => {
  FakeSocket.instances = [];
});

describe("新同步开关与 hook 生命周期", () => {
  const options = {
    agentId: "env_1",
    instanceUid: "inst_1",
    rcsSessionId: "rcs_1",
    organizationId: "org_1",
    url: "ws://test.local/acp/yjs/env_1?chatSync=1",
    socketFactory: enabledFactory,
  };

  // 服务端明确禁用或版本不兼容只回退一次，父组件刷新不得再建连。
  test("默认连接在明确拒绝时释放并锁定旧路径", () => {
    for (const [code, reason] of [
      [1008, "sync protocol disabled"],
      [1008, "sync protocol unavailable"],
      [1002, "unsupported version"],
    ] as const) {
      FakeSocket.instances = [];
      const harness = renderHook(options);
      const socket = FakeSocket.instances[0]!;
      act(() => socket.open());
      act(() => socket.onclose?.(code, reason));
      expect(harness.latest.current?.legacyFallback).toBe(true);
      expect(harness.latest.current?.projection.messages).toHaveLength(0);
      harness.rerender({ ...options });
      expect(FakeSocket.instances).toHaveLength(1);
      expect(socket.sent).toHaveLength(1);
      harness.unmount();
    }
  });

  // 1011 同样撤销失效投影并交回旧通道；错误仍保留给界面展示恢复信号（B09）。
  test("1011 回退旧通道且保留错误态", () => {
    const harness = renderHook(options);
    const socket = FakeSocket.instances.at(-1)!;
    act(() => socket.open());
    act(() => socket.onclose?.(1011, "rejected"));
    expect(harness.latest.current?.legacyFallback).toBe(true);
    expect(harness.latest.current?.connection.status).toBe("error");
    expect(harness.latest.current?.projection.messages).toHaveLength(0);
    harness.unmount();
  });

  // 切换 ACP 会话销毁旧连接并屏蔽迟到回调，卸载后新连接同样释放。
  test("session 切换清理连接且旧回调不能污染新会话", () => {
    const harness = renderHook({ ...options, sessionKey: "ses_a" });
    const first = FakeSocket.instances[0]!;
    act(() => first.open());
    const staleClose = first.onclose;
    harness.rerender({ ...options, sessionKey: "ses_b" });
    expect(first.closed.at(-1)?.code).toBe(1000);
    expect(first.onmessage).toBeNull();
    expect(FakeSocket.instances).toHaveLength(2);
    act(() => staleClose?.(1008, "sync protocol disabled"));
    expect(harness.latest.current?.legacyFallback).toBe(false);
    expect(harness.latest.current?.projection.messages).toHaveLength(0);
    harness.unmount();
    expect(FakeSocket.instances[1]?.closed.at(-1)?.code).toBe(1000);
  });

  // 投影换代（load/create）同样重建连接：新会话不能沿用上一代次的 store 与历史。
  test("投影换代版本变化时重建同步连接", () => {
    const harness = renderHook({ ...options, projectionVersion: 0 });
    const first = FakeSocket.instances[0]!;
    act(() => first.open());
    harness.rerender({ ...options, projectionVersion: 1 });
    expect(first.closed.at(-1)?.code).toBe(1000);
    expect(first.onmessage).toBeNull();
    expect(FakeSocket.instances).toHaveLength(2);
    harness.unmount();
    expect(FakeSocket.instances[1]?.closed.at(-1)?.code).toBe(1000);
  });

  // 默认开启，只有显式 0 回退，旧的 1 链接继续可用。
  test("开关默认开启，chatSync=0 才关闭", () => {
    expect(readSyncChatSwitch("")).toBe(true);
    expect(readSyncChatSwitch("?chatSync=other")).toBe(true);
    expect(readSyncChatSwitch("?chatSync=0")).toBe(false);
    expect(readSyncChatSwitch("?chatSync=1")).toBe(true);
  });

  // 新协议复用同一个已认证 endpoint 的既有 query，并额外标记 chatSync=1。
  test("socket URL 复用 /acp/yjs 与既有参数", () => {
    const url = new URL(buildSyncChatSocketUrl("env_1", { instanceUid: "inst_1", rcsSessionId: "rcs_1" }));
    expect(url.pathname).toBe("/acp/yjs/env_1");
    expect(url.searchParams.get("instanceUid")).toBe("inst_1");
    expect(url.searchParams.get("rcsSessionId")).toBe("rcs_1");
    expect(url.searchParams.get("chatSync")).toBe("1");
  });

  // 内容块列表是联调注入的逗号分隔值：去空、去重。
  test("chatSyncDocs 去空去重", () => {
    expect(readSyncChatContentDocIds("?chatSyncDocs=a,%20b,a,,c")).toEqual(["a", "b", "c"]);
  });

  // 关闭时 hook 不得创建 socket：工厂一旦被调用就抛错，渲染本身必须成功。
  test("enabled=false 不建立连接", () => {
    const harness = renderHook({
      enabled: false,
      agentId: "env_1",
      instanceUid: "inst_1",
      rcsSessionId: "rcs_1",
      organizationId: "org_1",
      socketFactory: disabledFactory,
    });
    expect(harness.latest.current?.connection.status).toBe("idle");
    expect(FakeSocket.instances).toHaveLength(0);
    harness.unmount();
  });

  // 开启后只建一条新协议连接，open 即发二进制 HELLO；卸载时关闭 socket。
  test("enabled=true 建立独立连接并在卸载时释放", () => {
    const harness = renderHook({
      enabled: true,
      agentId: "env_1",
      instanceUid: "inst_1",
      rcsSessionId: "rcs_1",
      organizationId: "org_1",
      generation: "gen_hook0001",
      url: "ws://test.local/acp/yjs/env_1?chatSync=1",
      socketFactory: enabledFactory,
    });
    expect(FakeSocket.instances).toHaveLength(1);
    const socket = FakeSocket.instances[0];
    act(() => socket?.open());
    expect(harness.latest.current?.connection.status).toBe("handshaking");
    expect(socket?.sent[0]?.[0]).toBe(0x7b);

    harness.unmount();
    expect(socket?.closed.at(-1)?.code).toBe(1000);
  });

  // 缺少组织上下文时即使开关打开也不建连（HELLO scope 不完整，无法通过服务端鉴权）。
  test("缺少组织时不建连", () => {
    const harness = renderHook({
      enabled: true,
      agentId: "env_1",
      instanceUid: "inst_1",
      rcsSessionId: "rcs_1",
      organizationId: null,
      socketFactory: enabledFactory,
    });
    expect(FakeSocket.instances).toHaveLength(0);
    expect(harness.latest.current?.connection.status).toBe("idle");
    harness.unmount();
  });
});
