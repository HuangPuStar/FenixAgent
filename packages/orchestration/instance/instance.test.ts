/**
 * Instance 子域测试：停止帧发送失败路径与正常停止路径。
 *
 * 背景（A-P1.2）：WsAgentNodeSocket.send 在信道不可用时从「静默丢弃」改为显式抛
 * AgentNodeUnavailableError 后，Instance.stop() 必须捕获该错误继续标记终止，否则
 * AgentController.stopInstance 会在 instance.stop() 中断，活跃表与节点引用残留
 * （幽灵实例）。本测试通过注入 send 抛错的 MockSocket 模拟断连窗口的信道不可用。
 */

import { describe, expect, test } from "bun:test";
import { AgentNode } from "../src/agent-node/agent-node";
import type { AgentNodeSocket } from "../src/agent-node/types";
import { AgentNodeUnavailableError } from "../src/errors";
import type { LaunchSpec } from "../src/launch-spec/types";

/** Mock WS 信道：send 可配置为抛错（模拟 readyState!==1 的信道不可用）。 */
class MockSocket implements AgentNodeSocket {
  sent: unknown[] = [];
  closed = false;
  #sendThrows: boolean;
  #closeHandler: (() => void) | null = null;

  constructor(sendThrows = false) {
    this.#sendThrows = sendThrows;
  }

  onOpen(_handler: () => void): void {}
  onClose(handler: () => void): void {
    this.#closeHandler = handler;
  }
  onError(_handler: () => void): void {}

  send(data: unknown): void {
    if (this.#sendThrows) {
      throw new AgentNodeUnavailableError("Agent node socket is not open");
    }
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.#closeHandler?.();
  }
}

/** 最小 LaunchSpec：仅 instanceId / agentConfig.id 参与 Instance 构造。 */
const launchSpec: LaunchSpec = {
  environmentId: "env1",
  agentConfig: {
    id: "cfg1",
    name: "test-agent",
    systemPrompt: null,
    modelProviderId: "provider-1",
    modelName: "model-1",
    engineId: "engine1",
    skills: [],
    mcpServers: [],
    knowledgeBases: [],
  },
  engine: { id: "engine1", type: "opencode", version: "1.0" },
  cwd: "/tmp/workspaces/org1/user1/env1",
  userId: "user1",
};

function createConnectedInstance(socket: AgentNodeSocket): ReturnType<AgentNode["_spawnInstance"]> {
  const node = new AgentNode({ machineId: "m1", socket });
  node._handleConnected();
  expect(node.status()).toBe("connected");
  return node._spawnInstance(launchSpec);
}

describe("Instance.stop", () => {
  // 停止帧发送失败（信道不可用）时 stop() 仍标记终止：保证 stopInstance 流程不中断、
  // 不产生幽灵活跃表（WsAgentNodeSocket.send 抛错后的必要配套）
  test("stop 帧发送失败仍标记实例终止", () => {
    const instance = createConnectedInstance(new MockSocket(true));

    expect(() => instance.stop()).not.toThrow();
    expect(instance.status()).toBe("stopped");
    expect(() => instance.stop()).not.toThrow(); // 幂等：重复停止不抛错
    expect(instance.status()).toBe("stopped");
  });

  // connected 正常路径不变：停止帧发出且状态终止，帧字段为机器端协议约定的
  // snake_case instance_id
  test("connected 时 stop 发送停止帧并标记终止", () => {
    const socket = new MockSocket();
    const instance = createConnectedInstance(socket);

    instance.stop();

    expect(socket.sent).toEqual([{ type: "stop", instance_id: instance.instanceId }]);
    expect(instance.status()).toBe("stopped");
  });

  // 已终止实例重复 stop 不重复发送停止帧（幂等语义，避免机器端重复停止）
  test("重复 stop 只发送一次停止帧", () => {
    const socket = new MockSocket();
    const instance = createConnectedInstance(socket);

    instance.stop();
    instance.stop();

    expect(socket.sent).toHaveLength(1);
  });
});
