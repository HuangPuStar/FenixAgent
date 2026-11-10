import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import {
  FakeWebSocket,
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

/** 物理 open 但不交付命令代次，复现应用层握手悬挂。 */
function openWithoutCommandEpoch(socket: FakeWebSocket): void {
  act(() => {
    socket.readyState = FakeWebSocket.OPEN;
    socket.onopen?.();
  });
}

describe("ChatPanel 卡在 connecting 的恢复探测", () => {
  // 物理 OPEN 但命令握手未完成时不会触发 close；页面回到前台必须重建一次传输，
  // 否则界面永久停在 connecting，且同一段卡顿内重复恢复事件不得制造重连风暴。
  test("返回前台时对卡住的 connecting 只重建一次连接", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    try {
      const socket = legacySockets()[0];
      expect(socket).toBeDefined();
      if (!socket) return;
      openWithoutCommandEpoch(socket);
      expect(harness.latest.current?.connectionState).toBe("connecting");

      act(() => {
        win.document.dispatchEvent(new win.Event("visibilitychange"));
      });
      expect(legacySockets()).toHaveLength(2);

      act(() => {
        win.document.dispatchEvent(new win.Event("visibilitychange"));
      });
      expect(legacySockets()).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  // 网络恢复事件走同一条探测路径；重建只重连传输，不重发任何结果未知的 prompt。
  test("online 事件探测卡住的 connecting 且不重发 prompt", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    try {
      const socket = legacySockets()[0];
      expect(socket).toBeDefined();
      if (!socket) return;
      openWithoutCommandEpoch(socket);
      const sentBefore = socket.sent.length;

      act(() => {
        win.dispatchEvent(new win.Event("online"));
      });
      expect(legacySockets()).toHaveLength(2);
      expect(socket.sent).toHaveLength(sentBefore);

      act(() => {
        win.dispatchEvent(new win.Event("online"));
      });
      expect(legacySockets()).toHaveLength(2);
    } finally {
      harness.unmount();
    }
  });

  // 已连接的健康会话在恢复前台时不得被打断，否则会掐断正在进行的回复。
  test("已连接时不因前台恢复事件重建", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    try {
      const socket = legacySockets()[0];
      expect(socket).toBeDefined();
      act(() => socket?.open());
      expect(harness.latest.current?.connectionState).toBe("connected");

      act(() => {
        win.document.dispatchEvent(new win.Event("visibilitychange"));
        win.dispatchEvent(new win.Event("online"));
      });
      expect(legacySockets()).toHaveLength(1);
      expect(harness.latest.current?.connectionState).toBe("connected");
    } finally {
      harness.unmount();
    }
  });
});
