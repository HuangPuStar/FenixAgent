/**
 * P0-07 回归：ws-handler 的心跳超时回调不得断开已恢复心跳或已被接管的连接。
 *
 * 通过真实注册/心跳消息驱动 handler，machine registry 端口用包内 `../server/testing` 的替身替换；
 * 只需控制时钟，不依赖真实定时器，也不替换模块。
 */
import { afterEach, beforeEach, describe, expect, jest, mock, setSystemTime, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { MACHINE_PROTOCOL_VERSION, SERVER_EPOCH } from "@fenix/remote-runtime";
import {
  handleAcpWsClose,
  handleAcpWsOpen,
  initializeAgentRuntimeModuleConfig,
  stubCoreRuntimeFacade,
  stubMachineRegistryPort,
} from "../server/testing";
import { handleAcpWsMessage } from "../server/transport/acp-ws-handler";
import { getAgentNodeService } from "../transport/agent-node-bridge";
import type { WsConnection } from "../types/ws-types";

const MACHINE_ID = "mach_p0_07_ws";
const START = new Date("2026-01-01T00:00:00.000Z");

type Connection = { ws: WsConnection; wsId: string };

let timeoutCallbacks: Array<() => void>;
let stopCalls: Array<{ machineId: string; connectionId?: string }>;
let connections: Connection[];

function createMockWs(): WsConnection {
  return {
    readyState: 1,
    send: mock((_data: string | Uint8Array) => {}),
    close: mock((_code?: number, _reason?: string) => {}),
  } as unknown as WsConnection;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/** 建立 machine 连接并完成注册；`confirm` 控制是否发送 clean-slate 确认（心跳分支要求已确认）。 */
async function connectMachine(wsId: string, machineId = MACHINE_ID, confirm = true): Promise<WsConnection> {
  const ws = createMockWs();
  connections.push({ ws, wsId });
  handleAcpWsOpen(ws, wsId, "user_p0_07", null, true);
  await handleAcpWsMessage(ws, wsId, {
    type: "register",
    agent_name: "p0-07-machine",
    protocol_version: MACHINE_PROTOCOL_VERSION,
    machine_id: machineId,
  });
  await flushMicrotasks();
  if (confirm) {
    await handleAcpWsMessage(ws, wsId, {
      type: "clean_slate_confirmed",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      server_epoch: SERVER_EPOCH,
    });
  }
  return ws;
}

beforeEach(() => {
  initializeAgentRuntimeModuleConfig({ wsKeepaliveInterval: 30 });
  jest.useFakeTimers();
  setSystemTime(START);
  timeoutCallbacks = [];
  stopCalls = [];
  connections = [];
  stubMachineRegistryPort({
    registerMachine: async ({ machineId }) => ({ id: machineId, isNew: true }),
    disconnectMachine: async () => {},
    startHeartbeat: (_machineId, _intervalMs, onTimeout) => {
      timeoutCallbacks.push(onTimeout);
    },
    handleHeartbeat: async () => {},
    stopHeartbeat: (machineId, connectionId) => {
      stopCalls.push({ machineId, connectionId });
    },
  });
  stubCoreRuntimeFacade({ getInstance: () => null, listInstances: () => [] });
});

afterEach(async () => {
  for (const { ws, wsId } of connections) handleAcpWsClose(ws, wsId);
  getAgentNodeService().notifyNodeDisconnected(MACHINE_ID);
  // 等清理尾部 fire-and-forget 的 import 落地，避免 resetAllStubs 后它们再读已解绑的 core port。
  await flushMicrotasks();
  jest.useRealTimers();
  await new Promise((resolve) => setTimeout(resolve, 0));
  resetAllStubs();
});

describe("machine 心跳超时断连复核", () => {
  // 同一连接刚收到合法心跳：迟到的旧超时回调不得关闭健康连接。
  test("收到心跳后旧超时回调不再断开同一连接", async () => {
    const ws = await connectMachine("ws_p0_07_a");
    expect(timeoutCallbacks).toHaveLength(1);

    await handleAcpWsMessage(ws, "ws_p0_07_a", { type: "heartbeat" });
    // 模拟 timer 已排队、回调在心跳落库之后才执行。
    setSystemTime(new Date(START.getTime() + 1_000));
    const closeMock = ws.close as ReturnType<typeof mock>;
    closeMock.mockClear();

    timeoutCallbacks[0]();

    expect(closeMock).not.toHaveBeenCalled();
  });

  // 真正没有心跳超过 90 秒：回调仍须关闭连接一次并执行清理。
  test("无心跳超过阈值时超时回调断开连接", async () => {
    const ws = await connectMachine("ws_p0_07_b");
    setSystemTime(new Date(START.getTime() + 90_001));
    const closeMock = ws.close as ReturnType<typeof mock>;

    timeoutCallbacks[0]();

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith(1011, "heartbeat timeout");
  });

  // 旧连接关闭后新连接已接管：旧超时回调不得关闭新连接。
  test("旧连接超时回调不得关闭接管的新连接", async () => {
    const oldWs = await connectMachine("ws_p0_07_old");
    const oldCallback = timeoutCallbacks[0];
    handleAcpWsClose(oldWs, "ws_p0_07_old");

    const newWs = await connectMachine("ws_p0_07_new");
    const closeMock = newWs.close as ReturnType<typeof mock>;
    closeMock.mockClear();

    oldCallback();

    expect(closeMock).not.toHaveBeenCalled();
  });

  // 过期 timeout 回调被跳过时不得停止当前连接的心跳 timer；之后真正静默仍断开一次。
  test("过期 timeout 回调保留心跳 timer，后续真实静默仍断开一次", async () => {
    const ws = await connectMachine("ws_p0_07_stale");
    await handleAcpWsMessage(ws, "ws_p0_07_stale", { type: "heartbeat" });

    setSystemTime(new Date(START.getTime() + 1_000));
    const closeMock = ws.close as ReturnType<typeof mock>;
    closeMock.mockClear();
    timeoutCallbacks[0]();

    expect(closeMock).not.toHaveBeenCalled();
    // 提前 return 不得先停心跳，否则后续真实超时永远不会触发。
    expect(stopCalls).toHaveLength(0);

    // 模拟仍生效的 timer 在阈值之后触发：此时确已静默，必须断开并只停一次心跳。
    setSystemTime(new Date(START.getTime() + 91_000));
    timeoutCallbacks[0]();

    expect(closeMock).toHaveBeenCalledTimes(1);
    expect(closeMock).toHaveBeenCalledWith(1011, "heartbeat timeout");
    expect(stopCalls).toEqual([{ machineId: MACHINE_ID, connectionId: "ws_p0_07_stale" }]);
  });

  // 快速重连时旧连接 close 只能停自己的心跳 timer，新连接仍按自己的期限断开。
  test("旧连接 close 不影响新连接的心跳 timer", async () => {
    const oldWsId = "ws_p0_07_old_close";
    const oldWs = await connectMachine(oldWsId, MACHINE_ID, false);
    // 旧 socket 进入关闭中，重复连接检查才允许新连接注册。
    (oldWs as { readyState: number }).readyState = 0;

    const newWsId = "ws_p0_07_new_close";
    const newWs = await connectMachine(newWsId, MACHINE_ID, false);
    const newCloseMock = newWs.close as ReturnType<typeof mock>;

    // 让新连接暂时不可见于 activeConn 检查，强制旧 close 的清理走到 stopHeartbeat 调用点。
    (newWs as { readyState: number }).readyState = 0;
    handleAcpWsClose(oldWs, oldWsId);
    expect(stopCalls).toEqual([{ machineId: MACHINE_ID, connectionId: oldWsId }]);

    // 新连接的 timer 未被旧 close 停止：恢复后真正静默仍会断开新连接一次。
    (newWs as { readyState: number }).readyState = 1;
    setSystemTime(new Date(START.getTime() + 91_000));
    timeoutCallbacks[1]();

    expect(newCloseMock).toHaveBeenCalledTimes(1);
    expect(stopCalls).toEqual([
      { machineId: MACHINE_ID, connectionId: oldWsId },
      { machineId: MACHINE_ID, connectionId: newWsId },
    ]);
  });
});
