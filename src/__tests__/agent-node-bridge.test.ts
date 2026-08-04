/**
 * agent-node-bridge 测试：惰性单例与 NaN 空闲超时防御。
 *
 * 背景：桥接层模块在静态导入阶段执行（早于 index.ts 的 applyEnv(validateEnv())），
 * 此前 config.acpIdleTimeoutSeconds 为 undefined，undefined * 1000 = NaN 会让
 * setTimeout(fn, NaN) 立即触发——机器注册后瞬间被空闲回收关闭（无限重连循环）。
 * 回归断言：undefined 配置下创建的 AgentNodeService 不会立即回收节点。
 */

import { afterEach, describe, expect, test } from "bun:test";
import type { AgentNodeSocket } from "@fenix/orchestration";
import { config, setConfig } from "../config";
import {
  createAgentNodeService,
  dispatchAgentNodeDisconnect,
  getAgentNodeService,
} from "../transport/agent-node-bridge";

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

/** 模拟模块加载期（config 尚未 applyEnv）的状态：idle 配置为 undefined。 */
function simulatePreApplyEnvState(): void {
  setConfig({ acpIdleTimeoutSeconds: undefined });
}

describe("agent-node-bridge", () => {
  const original = config;

  afterEach(() => {
    setConfig(original);
  });

  test("createAgentNodeService：idle 配置未就绪时兜底 300s，注册节点不会被立即回收", async () => {
    simulatePreApplyEnvState();

    const service = createAgentNodeService();
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("m1", socket);

    // 若 idleTimeoutMs 为 NaN，定时器约 0ms 触发并关闭节点；等待一个事件循环验证
    await Bun.sleep(20);
    expect(node.status()).not.toBe("closed");
    expect(node.status()).toBe("connected");

    // 显式关闭收尾，避免节点滞留管理集合
    node.close();
  });

  test("createAgentNodeService：ensureNode 取消空闲回收后节点保持 connected", async () => {
    simulatePreApplyEnvState();

    const service = createAgentNodeService();
    const socket = new MockSocket();
    service.handleIncomingConnection("m1", socket);
    const node = service.ensureNode("m1");

    await Bun.sleep(20);
    expect(node.status()).toBe("connected");

    service.releaseNode("m1");
    node.close();
  });

  test("getAgentNodeService：惰性创建且复用同一实例", () => {
    const a = getAgentNodeService();
    const b = getAgentNodeService();
    expect(a).toBe(b);
  });

  // sweep 清理路径无 WsConnection 可引用，dispatchAgentNodeDisconnect 按 machineId
  // 通知：connected 节点必须进入 disconnected（与 dispatchAgentNodeWsClose 等效）
  test("dispatchAgentNodeDisconnect：connected 节点进入 disconnected", () => {
    const service = getAgentNodeService();
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("e2p1-bridge-m1", socket);
    expect(node.status()).toBe("connected");

    dispatchAgentNodeDisconnect("e2p1-bridge-m1");
    expect(node.status()).toBe("disconnected");

    // 收尾：断开态 close 只推进 FSM，不触碰 WS 信道
    node.close();
  });

  // sweep 巡检可能命中从未建立连接的 machine（服务重启后 DB 残留 online）：
  // 未管理 machineId 必须幂等忽略，不得抛错
  test("dispatchAgentNodeDisconnect：未管理 machineId 不抛错", () => {
    expect(() => dispatchAgentNodeDisconnect("e2p1-bridge-ghost")).not.toThrow();
  });
});
