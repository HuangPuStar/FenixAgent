/**
 * WsAgentNodeSocket.send 行为测试：断连（readyState!==1）时必须显式抛错而非静默丢包。
 *
 * 背景（A-P1.2 / E-P2.1）：sweep 清理路径（triggerMachineCleanupByMachineId）不经过
 * dispatchAgentNodeWsClose，节点 FSM 保持 stale connected 而底层 WS 已关闭；若 send
 * 静默丢弃，停止帧丢失无任何回执，调用方误以为消息可达。显式抛 AgentNodeUnavailableError
 * 后由 Instance.stop() 捕获，停止流程不中断。
 *
 * 仅测试 wsToAgentNodeSocket 适配器本身（WeakMap 缓存 + 帧格式），不触碰
 * AgentNodeService 单例，无需 DB / registry stub。
 */

import { describe, expect, test } from "bun:test";
import { AgentNodeUnavailableError } from "@fenix/orchestration";
import { wsToAgentNodeSocket } from "../transport/agent-node-bridge";
import type { WsConnection } from "../transport/ws-types";

function createMockWs(readyState = 1): WsConnection & { _messages: string[] } {
  const messages: string[] = [];
  const ws = {
    readyState,
    send: (data: string) => {
      messages.push(data);
    },
    close: () => {},
    _messages: messages,
  } as unknown as WsConnection & { _messages: string[] };
  return ws;
}

describe("WsAgentNodeSocket.send", () => {
  // send 在 WS 未打开（readyState!==1）时抛 AgentNodeUnavailableError 而非静默丢弃
  // （A-P1.2 验收点 13：stale connected 信道不可用时消息必须显式失败）
  test("readyState!==1 时抛 AgentNodeUnavailableError", () => {
    const adapter = wsToAgentNodeSocket(createMockWs(0)); // CONNECTING
    expect(() => adapter.send({ type: "stop", instance_id: "inst_1" })).toThrow(AgentNodeUnavailableError);
  });

  // connected（readyState===1）时正常发送，帧格式为 NDJSON（JSON.stringify + "\n"，
  // 与 acp-ws-handler.sendToWs 保持一致）
  test("readyState===1 时发送 NDJSON 帧", () => {
    const ws = createMockWs(1); // OPEN
    const adapter = wsToAgentNodeSocket(ws);
    adapter.send({ type: "stop", instance_id: "inst_1" });
    expect(ws._messages).toEqual(['{"type":"stop","instance_id":"inst_1"}\n']);
  });

  // close 后（CLOSING / CLOSED）发送同样抛错：关闭中语义与断连一致，调用方不得
  // 在关闭窗口内继续写入
  test("readyState 为 CLOSING / CLOSED 时抛错", () => {
    const closingAdapter = wsToAgentNodeSocket(createMockWs(2)); // CLOSING
    expect(() => closingAdapter.send({ type: "stop" })).toThrow(AgentNodeUnavailableError);

    const closedAdapter = wsToAgentNodeSocket(createMockWs(3)); // CLOSED
    expect(() => closedAdapter.send({ type: "stop" })).toThrow(AgentNodeUnavailableError);
  });
});
