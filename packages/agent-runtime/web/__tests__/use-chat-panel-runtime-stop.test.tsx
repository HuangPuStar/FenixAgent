import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import {
  FakeWebSocket,
  installFakeWebSocket,
  renderRuntime,
  restoreFakeWebSocket,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

describe("useChatPanelRuntime 主动停止实例", () => {
  // 鉴权拒绝须结束重连轻提示，并把权限语义交给面板，而不是继续显示重连中。
  test("4003 停止重连并暴露权限错误", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    try {
      act(() => FakeWebSocket.instances[0]?.closeFromServer(4003, "unauthorized"));
      expect(harness.latest.current?.autoReconnecting).toBe(false);
      expect(harness.latest.current?.terminalUiCode).toBe("unauthorized");
      expect(harness.latest.current?.connectionState).toBe("error");
    } finally {
      harness.unmount();
    }
  });
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
