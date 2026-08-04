/**
 * machine 清理路径的编排域节点通知集成测试（E-P2.1）。
 *
 * 根因：sweep（startMachineSweep → triggerMachineCleanupByMachineId）清理断连机器时
 * 未通知编排域 AgentNode，节点保持 stale connected，ensureNode 放行 spawn 走死信道。
 * 本文件从宿主入口 triggerMachineCleanupByMachineId 验证节点状态被纠正为 disconnected。
 * registry / registry-heartbeat / core-bootstrap 已在 setup-mocks.ts 中通过 preload
 * mock 注册（createLazyMock 模式），stub 行为通过 stubXxx() 在 beforeEach 中配置。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AgentNode, type AgentNodeSocket, AgentNodeUnavailableError } from "@fenix/orchestration";
import { resetAllStubs, stubCoreBootstrap, stubRegistry } from "../test-utils/helpers";
import { getAgentNodeService } from "../transport/agent-node-bridge";

/** 最小 AgentNodeSocket：close 立即确认。 */
class MockSocket implements AgentNodeSocket {
  #onClose: (() => void) | null = null;

  onOpen(_handler: () => void): void {}

  onClose(handler: () => void): void {
    this.#onClose = handler;
  }

  onError(_handler: () => void): void {}

  send(_data: unknown): void {}

  close(): void {
    this.#onClose?.();
  }
}

/** 当前用例注册的节点，afterEach 统一收尾（断开态 close 只推进 FSM，不触碰 WS）。 */
let registeredNode: AgentNode | null = null;

beforeEach(() => {
  resetAllStubs();
  // disconnectMachine 必须配置：未配置时空 stub 返回 undefined，
  // triggerMachineCleanupByMachineId 的 .catch 会对 undefined 调用抛 TypeError
  stubRegistry({ disconnectMachine: async () => {} });
  stubCoreBootstrap({
    getCoreRuntime: () => ({ listInstances: () => [] }),
    unregisterRemoteNode: () => {},
  });
});

afterEach(() => {
  registeredNode?.close();
  registeredNode = null;
  resetAllStubs();
});

describe("triggerMachineCleanupByMachineId 编排域节点通知", () => {
  // sweep 路径主验收：清理入口必须把 stale connected 节点纠正为 disconnected，
  // ensureNode 不再放行 spawn 走死信道（E-P2.1）
  test("sweep 清理路径把 stale connected 节点纠正为 disconnected", async () => {
    const socket = new MockSocket();
    registeredNode = getAgentNodeService().handleIncomingConnection("e2p1-cleanup-m1", socket);
    expect(registeredNode.status()).toBe("connected");

    const { triggerMachineCleanupByMachineId } = await import("../transport/acp-ws-handler");
    triggerMachineCleanupByMachineId("e2p1-cleanup-m1", "sweep: no active WS connection");

    expect(registeredNode.status()).toBe("disconnected");
    expect(() => getAgentNodeService().ensureNode("e2p1-cleanup-m1")).toThrow(AgentNodeUnavailableError);
  });

  // 服务重启后 DB 残留 online 但从未建立连接的机器：清理路径不得抛错
  test("未注册节点的清理路径不抛错", async () => {
    const { triggerMachineCleanupByMachineId } = await import("../transport/acp-ws-handler");
    expect(() =>
      triggerMachineCleanupByMachineId("e2p1-cleanup-ghost", "sweep: no active WS connection"),
    ).not.toThrow();
  });
});
