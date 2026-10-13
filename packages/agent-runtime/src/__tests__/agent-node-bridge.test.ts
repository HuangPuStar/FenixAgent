/**
 * agent-node-bridge 测试：装配契约、惰性单例与断连分发。
 *
 * 背景（1.4 W1 配置搬家）：空闲回收阈值 `idleTimeoutMs` 的来源从宿主 `config` 改为本包模块配置
 * （`acpIdleTimeoutSeconds`）。迁移前的风险场景是——桥接层模块在静态导入阶段执行（早于宿主
 * `applyEnv(validateEnv())`），`config.acpIdleTimeoutSeconds` 为 `undefined`，`undefined * 1000 = NaN`
 * 让 `setTimeout(fn, NaN)` 立即触发，机器注册后瞬间被空闲回收关闭（表现为无限重连循环），旧实现因此用
 * `Number.isFinite` 兜底 300s。
 *
 * 迁移后的语义变化：配置缺失不再退化为 NaN，而是由 `getAgentRuntimeConfig()` 抛错（未装配时抛
 * 「应用基础设施尚未初始化」，装配但漏键时抛「agent-runtime 模块配置校验失败」），兜底值随之删除。
 * 本文件据此断言：
 *   1. 装配后创建的 AgentNodeService 不会立即回收节点（即定时器周期不是 NaN）；
 *   2. 配置漏键时 `createAgentNodeService()` 抛校验错误，而不是造出一个 NaN 定时器；
 *   3. 惰性单例复用与 disconnect 分发语义不变。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { AgentNodeSocket } from "@fenix/orchestration";
import { overrideModuleConfig } from "@fenix/platform-sdk/server";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { initializeAgentRuntimeModuleConfig } from "../server/testing";
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

describe("agent-node-bridge", () => {
  beforeEach(() => {
    initializeAgentRuntimeModuleConfig({ acpIdleTimeoutSeconds: 300 });
  });

  afterEach(() => {
    resetAllStubs();
  });

  // 空闲阈值取自注入的模块配置：注册节点后的定时器必须真的等到 300s，而不是 NaN 造成的 0ms 立即回收
  test("createAgentNodeService：装配后注册的节点不会被立即回收", async () => {
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

  // ensureNode 占引用后空闲定时器不回收节点（阈值仍来自模块配置，不因单例复用而变化）
  test("createAgentNodeService：ensureNode 取消空闲回收后节点保持 connected", async () => {
    const service = createAgentNodeService();
    const socket = new MockSocket();
    service.handleIncomingConnection("m1", socket);
    const node = service.ensureNode("m1");

    await Bun.sleep(20);
    expect(node.status()).toBe("connected");

    service.releaseNode("m1");
    node.close();
  });

  // 配置缺失必须显式失败：迁移前这里会静默造出 NaN 定时器把节点秒回收，掩盖「宿主漏注入某个键」。
  // 宿主 main.ts 的注入清单一旦漏项（或键名改错），strictObject 校验必须在读取处立刻报出模块与字段。
  test("createAgentNodeService：模块配置缺字段时抛校验错误，不退化为 NaN 定时器", () => {
    // overrideModuleConfig 是整值替换：只给一个键，等价于宿主注入清单漏掉其余三个
    overrideModuleConfig("agent-runtime", { acpIdleTimeoutSeconds: 300 });
    expect(() => createAgentNodeService()).toThrow(/agent-runtime 模块配置校验失败/);
  });

  test("getAgentNodeService：惰性创建且复用同一实例", () => {
    const a = getAgentNodeService();
    const b = getAgentNodeService();
    expect(a).toBe(b);
  });

  // sweep 清理路径无 WsConnection 可引用，dispatchAgentNodeDisconnect 按 machineId
  // 通知：connected 节点必须进入 disconnected（与 dispatchAgentNodeWsClose 等效）。
  // E-P2.2 方案 A：无引用节点断连即回收（断连即终态），先 ensureNode 占引用
  // 以验证 disconnected 停留态；无引用断连即回收的路径由 agent-node-service 测试覆盖。
  test("dispatchAgentNodeDisconnect：connected 节点进入 disconnected", () => {
    const service = getAgentNodeService();
    const socket = new MockSocket();
    const node = service.handleIncomingConnection("e2p1-bridge-m1", socket);
    service.ensureNode("e2p1-bridge-m1");
    expect(node.status()).toBe("connected");

    dispatchAgentNodeDisconnect("e2p1-bridge-m1");
    expect(node.status()).toBe("disconnected");

    // 收尾：断开态 close 只推进 FSM，不触碰 WS 信道
    service.releaseNode("e2p1-bridge-m1");
    node.close();
  });

  // sweep 巡检可能命中从未建立连接的 machine（服务重启后 DB 残留 online）：
  // 未管理 machineId 必须幂等忽略，不得抛错
  test("dispatchAgentNodeDisconnect：未管理 machineId 不抛错", () => {
    expect(() => dispatchAgentNodeDisconnect("e2p1-bridge-ghost")).not.toThrow();
  });
});
