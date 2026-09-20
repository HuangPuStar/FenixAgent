import { describe, expect, test } from "bun:test";
import { AgentController } from "../agent-controller";
import { AgentNode } from "../agent-node/agent-node";
import { AgentNodeFsm } from "../agent-node/agent-node-fsm";
import type { AgentNodeServicePort, AgentNodeSocket } from "../agent-node/types";
import {
  AgentNodeUnavailableError,
  EnvironmentNotFoundError,
  IllegalStateTransitionError,
  LaunchSpecBuildError,
  MachineOfflineError,
  OrchestrationError,
} from "../errors";
import { Instance } from "../instance/instance";
import type { EnvironmentData, EnvironmentRepo } from "../types/deps";

class FakeSocket implements AgentNodeSocket {
  readonly sent: unknown[] = [];
  closed = false;
  throwOnSend = false;
  #openHandler: (() => void) | undefined;
  #closeHandler: (() => void) | undefined;
  #errorHandler: (() => void) | undefined;

  send(data: unknown): void {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.#closeHandler?.();
  }

  onOpen(handler: () => void): void {
    this.#openHandler = handler;
  }

  onClose(handler: () => void): void {
    this.#closeHandler = handler;
  }

  onError(handler: () => void): void {
    this.#errorHandler = handler;
  }

  open(): void {
    this.#openHandler?.();
  }

  disconnect(): void {
    this.#closeHandler?.();
  }

  fail(): void {
    this.#errorHandler?.();
  }
}

const environment: EnvironmentData = {
  id: "env-1",
  organizationId: "org-1",
  agentConfigId: "config-1",
  machineId: "machine-1",
  autoStart: false,
};

/** 假环境仓库：记录每次 getEnvironment 的入参，便于断言 spawn 透传了请求者身份。 */
function createEnvironmentRepo(options?: { environment?: EnvironmentData | null }): EnvironmentRepo & {
  calls: [string, string | undefined][];
} {
  const calls: [string, string | undefined][] = [];
  return {
    calls,
    getEnvironment: async (envId, userId) => {
      calls.push([envId, userId]);
      return options?.environment === undefined ? environment : options.environment;
    },
  };
}

/**
 * 假节点服务 + 真 AgentNode：节点能力走真实实现（send/stop 语义需要它），
 * 服务侧只实现 AgentNodeServicePort 的两个操作，避免依赖 idle 回收与真实 WS。
 */
function createController(options?: { environment?: EnvironmentData | null; node?: AgentNode | null }): {
  controller: AgentController;
  environmentRepo: ReturnType<typeof createEnvironmentRepo>;
  released: string[];
} {
  const environmentRepo = createEnvironmentRepo({ environment: options?.environment });
  const released: string[] = [];
  const node = options?.node === undefined ? createConnectedNode() : options.node;
  const agentNodeService: AgentNodeServicePort = {
    ensureNode: (machineId) => {
      if (node === null) throw new AgentNodeUnavailableError();
      if (node.machineId !== machineId) throw new AgentNodeUnavailableError();
      return node;
    },
    releaseNode: (machineId) => {
      released.push(machineId);
    },
  };
  return { controller: new AgentController({ agentNodeService, environmentRepo }), environmentRepo, released };
}

function createConnectedNode(socket = new FakeSocket()): AgentNode {
  const node = new AgentNode({ machineId: "machine-1", socket });
  node._handleConnected();
  return node;
}

function createInstance(socket = new FakeSocket()): { instance: Instance; socket: FakeSocket; node: AgentNode } {
  const node = createConnectedNode(socket);
  return {
    socket,
    node,
    instance: new Instance({
      instanceId: "inst-1",
      environmentId: "env-1",
      agentConfigId: "config-1",
      agentNode: node,
    }),
  };
}

describe("编排基础模块隔离测试", () => {
  // 不存在的环境以领域错误拒绝，并保留环境 ID 作为诊断上下文；
  // （原 LaunchSpecBuilder 的「环境不存在」断言面在 CE 1.4 W4 收敛到 controller）。
  test("拒绝不存在的环境", async () => {
    const { controller } = createController({ environment: null });
    await expect(controller.spawnInstance("missing", "user-1", "inst-1")).rejects.toMatchObject({
      code: "ENVIRONMENT_NOT_FOUND",
      message: "Environment 'missing' not found",
    });
  });

  // 未绑定 Agent 配置的环境不能创建实例：本域只保证「有配置可启动」，
  // 错误码保持 LAUNCH_SPEC_BUILD_FAILED（宿主按 422 映射）。
  test("拒绝未绑定 Agent 配置的环境", async () => {
    const { controller } = createController({ environment: { ...environment, agentConfigId: null } });
    await expect(controller.spawnInstance("env-1", "user-1", "inst-1")).rejects.toBeInstanceOf(LaunchSpecBuildError);
  });

  // 未解析出执行机器的环境同样拒绝，避免实例落到无节点可用的状态。
  test("拒绝未解析出机器的环境", async () => {
    const { controller } = createController({ environment: { ...environment, machineId: null } });
    await expect(controller.spawnInstance("env-1", "user-1", "inst-1")).rejects.toMatchObject({
      code: "LAUNCH_SPEC_BUILD_FAILED",
      message: "Cannot spawn instance: environment 'env-1' has no machineId configured",
    });
  });

  // 创建实例必须把请求者透传给环境仓库（机器解析可能按用户归属），
  // 并把环境身份写入实例快照（启动参数由 Runtime 侧按同一身份组装）。
  test("按环境身份创建实例并透传请求者", async () => {
    const { controller, environmentRepo } = createController();
    const instance = await controller.spawnInstance("env-1", "user-99", "inst-1");

    expect(environmentRepo.calls).toEqual([["env-1", "user-99"]]);
    expect(instance.info()).toEqual({
      instanceId: "inst-1",
      environmentId: "env-1",
      agentConfigId: "config-1",
      machineId: "machine-1",
      status: "running",
    });
    expect(controller.listInstances().map((active) => active.instanceId)).toEqual(["inst-1"]);
  });

  // 停止实例后必须移出活跃表并归还节点引用，避免节点引用计数残留导致空闲回收不触发。
  test("停止实例后移出活跃表并归还引用", async () => {
    const { controller, released } = createController();
    await controller.spawnInstance("env-1", "user-1", "inst-1");

    await controller.stopInstance("inst-1");

    expect(controller.listInstances()).toEqual([]);
    expect(released).toEqual(["machine-1"]);
  });

  // 状态机从初始状态可按协议进入连接中。
  test("状态机接受初始连接事件", () => {
    expect(new AgentNodeFsm().transition("connect")).toBe("connecting");
  });

  // 状态机将 open 事件映射为已连接。
  test("状态机接受连接成功事件", () => {
    expect(new AgentNodeFsm("connecting").transition("open")).toBe("connected");
  });

  // 状态机将连接失败恢复为可重新接入的初始状态。
  test("状态机接受连接失败事件", () => {
    expect(new AgentNodeFsm("connecting").transition("fail")).toBe("uninitialized");
  });

  // 状态机将意外断连与主动关闭明确区分。
  test("状态机接受意外断连事件", () => {
    expect(new AgentNodeFsm("connected").transition("disconnect")).toBe("disconnected");
  });

  // 远端新连接可以从断连状态被动恢复。
  test("状态机允许断连后被动恢复", () => {
    expect(new AgentNodeFsm("disconnected").transition("open")).toBe("connected");
  });

  // 主动关闭先进入等待确认的中间状态。
  test("状态机接受关闭请求", () => {
    expect(new AgentNodeFsm("connected").transition("closeRequested")).toBe("closing");
  });

  // 收到关闭确认后进入终态。
  test("状态机接受关闭确认", () => {
    expect(new AgentNodeFsm("closing").transition("closeConfirmed")).toBe("closed");
  });

  // 非法转换必须抛出机器可识别的领域错误。
  test("状态机拒绝非法转换", () => {
    expect(() => new AgentNodeFsm("connected").transition("connect")).toThrow(IllegalStateTransitionError);
  });

  // 终态不应被任何事件重新激活。
  test("状态机拒绝终态转换", () => {
    expect(() => new AgentNodeFsm("closed").transition("open")).toThrow("Invalid transition: closed --open--> ?");
  });

  // 节点连通后可发送任意协议载荷且不改变内容。
  test("节点原样发送协议载荷", () => {
    const socket = new FakeSocket();
    const node = createConnectedNode(socket);
    const message = { type: "prompt", payload: { text: "hello" } };
    node.send(message);
    expect(socket.sent).toEqual([message]);
  });

  // 未连接节点不得把消息发送到不可靠信道。
  test("节点拒绝未连接时发送", () => {
    const node = new AgentNode({ machineId: "machine-1", socket: new FakeSocket() });
    expect(() => node.send({ type: "prompt" })).toThrow(AgentNodeUnavailableError);
  });

  // socket open 回调会驱动节点进入连接状态。
  test("socket 打开事件驱动节点连接", () => {
    const socket = new FakeSocket();
    const node = new AgentNode({ machineId: "machine-1", socket });
    socket.open();
    expect(node.status()).toBe("connected");
  });

  // socket error 会将已连接节点标记为断连。
  test("socket 错误驱动节点断连", () => {
    const socket = new FakeSocket();
    const node = createConnectedNode(socket);
    socket.fail();
    expect(node.status()).toBe("disconnected");
  });

  // 自动重连停止通知每次断连周期只会由有效连接触发。
  test("断连通知宿主停止自动重连", () => {
    let calls = 0;
    const socket = new FakeSocket();
    const node = new AgentNode({ machineId: "machine-1", socket, onAutoReconnectStopped: () => (calls += 1) });
    node._handleConnected();
    socket.disconnect();
    socket.disconnect();
    expect(calls).toBe(1);
  });

  // 替换信道时旧信道关闭事件不能污染新连接状态。
  test("替换信道隔离旧信道迟到事件", () => {
    const oldSocket = new FakeSocket();
    const node = createConnectedNode(oldSocket);
    const newSocket = new FakeSocket();
    node._attachSocket(newSocket);
    node._handleConnected();
    oldSocket.disconnect();
    expect(oldSocket.closed).toBe(true);
    expect(node.status()).toBe("connected");
  });

  // close 会关闭已连接 socket 并落入 closed 终态。
  test("节点关闭时清理底层信道", () => {
    const socket = new FakeSocket();
    const node = createConnectedNode(socket);
    node.close();
    expect(socket.closed).toBe(true);
    expect(node.status()).toBe("closed");
  });

  // 关闭终态节点为幂等操作，避免重复释放资源。
  test("节点重复关闭保持幂等", () => {
    const socket = new FakeSocket();
    const node = createConnectedNode(socket);
    node.close();
    node.close();
    expect(node.status()).toBe("closed");
  });

  // Instance 状态应从节点连接状态实时推导。
  test("实例将已连接节点映射为运行中", () => {
    expect(createInstance().instance.status()).toBe("running");
  });

  // 实例必须保留来源和机器信息，便于安全隔离和展示。
  test("实例序列化快照包含稳定身份字段", () => {
    expect(createInstance().instance.info()).toEqual({
      instanceId: "inst-1",
      environmentId: "env-1",
      agentConfigId: "config-1",
      machineId: "machine-1",
      status: "running",
    });
  });

  // 实例 send 应保持业务载荷原样通过节点传递。
  test("实例原样转发业务消息", () => {
    const { instance, socket } = createInstance();
    instance.send({ type: "input", content: ["text"] });
    expect(socket.sent).toEqual([{ type: "input", content: ["text"] }]);
  });

  // 已停止实例不得继续发送，避免消息误投给共享节点。
  test("实例停止后拒绝发送", () => {
    const { instance } = createInstance();
    instance.stop();
    expect(() => instance.send({ type: "input" })).toThrow("Instance inst-1 is terminated");
  });

  // 停止协议使用 snake_case instance_id 以兼容机器端契约。
  test("实例停止发送约定的停止帧", () => {
    const { instance, socket } = createInstance();
    instance.stop();
    expect(socket.sent).toEqual([{ type: "stop", instance_id: "inst-1" }]);
  });

  // 停止不会关闭共享节点，避免影响其他实例。
  test("实例停止不关闭共享节点", () => {
    const { instance, socket, node } = createInstance();
    instance.stop();
    expect(socket.closed).toBe(false);
    expect(node.status()).toBe("connected");
  });

  // 重复停止不得重复发送机器端停止指令。
  test("实例重复停止保持幂等", () => {
    const { instance, socket } = createInstance();
    instance.stop();
    instance.stop();
    expect(socket.sent).toHaveLength(1);
  });

  // 停止帧发送失败不能留下幽灵实例。
  test("停止帧发送失败仍完成本地清理", () => {
    const socket = new FakeSocket();
    socket.throwOnSend = true;
    const { instance } = createInstance(socket);
    instance.stop();
    expect(instance.status()).toBe("stopped");
  });

  // 节点断连时，未停止实例对外暴露 error 而非伪运行状态。
  test("实例将节点断连映射为错误", () => {
    const { instance, node } = createInstance();
    node._handleDisconnected();
    expect(instance.status()).toBe("error");
  });

  // 连接建立中实例对外呈现 starting 状态。
  test("实例将连接中节点映射为启动中", () => {
    const node = new AgentNode({ machineId: "machine-1", socket: new FakeSocket() });
    const instance = new Instance({
      instanceId: "inst-1",
      environmentId: "env-1",
      agentConfigId: "config-1",
      agentNode: node,
    });
    expect(instance.status()).toBe("starting");
  });

  // 关闭节点后的实例应呈现已停止状态。
  test("实例将关闭节点映射为已停止", () => {
    const { instance, node } = createInstance();
    node.close();
    expect(instance.status()).toBe("stopped");
  });

  // 错误基类保留指定名称、错误码和消息。
  test("基础编排错误保留可序列化错误码", () => {
    const error = new OrchestrationError("failed", "FAILED");
    expect({ name: error.name, message: error.message, code: error.code }).toEqual({
      name: "OrchestrationError",
      message: "failed",
      code: "FAILED",
    });
  });

  // 节点不可用错误使用稳定错误码供上层分类。
  test("节点不可用错误具有稳定错误码", () => {
    expect(new AgentNodeUnavailableError().code).toBe("AGENT_NODE_UNAVAILABLE");
  });

  // 并发错误使用稳定错误码供调用者处理限流。

  // 环境不存在错误使用稳定错误码避免依赖文案。
  test("环境不存在错误具有稳定错误码", () => {
    expect(new EnvironmentNotFoundError().code).toBe("ENVIRONMENT_NOT_FOUND");
  });

  // 机器离线错误使用稳定错误码区分配置与可用性问题。
  test("机器离线错误具有稳定错误码", () => {
    expect(new MachineOfflineError().code).toBe("MACHINE_OFFLINE");
  });

  // LaunchSpec 构建错误使用稳定错误码供 API 映射。
  test("LaunchSpec 构建错误具有稳定错误码", () => {
    expect(new LaunchSpecBuildError().code).toBe("LAUNCH_SPEC_BUILD_FAILED");
  });
});
