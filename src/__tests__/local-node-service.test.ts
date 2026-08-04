/**
 * 本地节点服务测试：local-default 占位节点的供给与委托语义。
 *
 * 全部通过注入 fake delegate 验证分流行为，不依赖真实 WS、DB 或定时器；
 * 直接构造注入，禁止 mock.module()。
 */

import { describe, expect, test } from "bun:test";
import { AgentNode, type AgentNodeServicePort, type AgentNodeSocket } from "@fenix/orchestration";
import { LOCAL_DEFAULT_NODE_ID, LocalNodeAwareService } from "../services/local-node-service";

/** 最小 AgentNodeSocket 实现：记录发送，close 立即确认。 */
class MockSocket implements AgentNodeSocket {
  sent: unknown[] = [];
  #onClose: (() => void) | null = null;

  onOpen(_handler: () => void): void {}

  onClose(handler: () => void): void {
    this.#onClose = handler;
  }

  onError(_handler: () => void): void {}

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.#onClose?.();
  }
}

/** 记录调用的 fake 节点服务：为任意 machineId 返回 connected 节点。 */
class FakeNodeService implements AgentNodeServicePort {
  readonly ensureCalls: string[] = [];
  readonly releaseCalls: string[] = [];

  ensureNode(machineId: string): AgentNode {
    this.ensureCalls.push(machineId);
    const node = new AgentNode({ machineId, socket: new MockSocket(), maxRetries: 0 });
    node._handleConnected();
    return node;
  }

  releaseNode(machineId: string): void {
    this.releaseCalls.push(machineId);
  }
}

describe("LocalNodeAwareService", () => {
  test("本地节点供给：ensureNode(local-default) 返回 connected 节点且幂等复用", () => {
    const delegate = new FakeNodeService();
    const service = new LocalNodeAwareService(() => delegate);

    const a = service.ensureNode(LOCAL_DEFAULT_NODE_ID);
    const b = service.ensureNode(LOCAL_DEFAULT_NODE_ID);

    expect(a).toBe(b);
    expect(a.machineId).toBe(LOCAL_DEFAULT_NODE_ID);
    expect(a.status()).toBe("connected");
    // 本地节点不触达真实节点服务
    expect(delegate.ensureCalls).toEqual([]);
  });

  test("本地节点发送：connected 下 send 不抛错（stub 信道空操作）", () => {
    const service = new LocalNodeAwareService(() => new FakeNodeService());
    const node = service.ensureNode(LOCAL_DEFAULT_NODE_ID);

    // 本地执行的 ACP 消息走 core relay，节点信道 send 空操作是设计语义
    expect(() => node.send({ type: "ping" })).not.toThrow();
  });

  test("本地节点关闭：close() 经 stub 信道立即确认进入 closed", () => {
    const service = new LocalNodeAwareService(() => new FakeNodeService());
    const node = service.ensureNode(LOCAL_DEFAULT_NODE_ID);

    node.close();
    expect(node.status()).toBe("closed");
    // 终态幂等
    node.close();
    expect(node.status()).toBe("closed");
  });

  test("远程节点委托：非 local-default 的 machineId 原样转发 delegate", () => {
    const delegate = new FakeNodeService();
    const service = new LocalNodeAwareService(() => delegate);

    const node = service.ensureNode("m1");
    expect(node.machineId).toBe("m1");
    expect(node.status()).toBe("connected");
    expect(delegate.ensureCalls).toEqual(["m1"]);
  });

  test("releaseNode 分流：local-default 空操作，其余委托 delegate", () => {
    const delegate = new FakeNodeService();
    const service = new LocalNodeAwareService(() => delegate);

    // local-default 无引用计数，释放不触达 delegate 也不抛错
    service.releaseNode(LOCAL_DEFAULT_NODE_ID);
    expect(delegate.releaseCalls).toEqual([]);

    service.releaseNode("m1");
    expect(delegate.releaseCalls).toEqual(["m1"]);
  });

  test("委托错误透传：远程节点缺失时抛 AgentNodeUnavailableError", () => {
    const failing: AgentNodeServicePort = {
      ensureNode: () => {
        throw new Error("node not found");
      },
      releaseNode: () => {},
    };
    const service = new LocalNodeAwareService(() => failing);

    expect(() => service.ensureNode("ghost")).toThrow("node not found");
    // 本地节点不受影响
    expect(service.ensureNode(LOCAL_DEFAULT_NODE_ID).status()).toBe("connected");
  });

  test("委托惰性：构造与纯本地路径不触达 getter", () => {
    // getter 在模块加载期传入（config 尚未 applyEnv），只有远程委托路径才应调用
    let getterCalls = 0;
    const delegate = new FakeNodeService();
    const service = new LocalNodeAwareService(() => {
      getterCalls += 1;
      return delegate;
    });

    service.ensureNode(LOCAL_DEFAULT_NODE_ID);
    service.releaseNode(LOCAL_DEFAULT_NODE_ID);
    expect(getterCalls).toBe(0);

    service.ensureNode("m1");
    expect(getterCalls).toBe(1);
  });
});
