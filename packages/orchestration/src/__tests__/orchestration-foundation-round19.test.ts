import { describe, expect, test } from "bun:test";
import { AgentNode } from "../agent-node/agent-node";
import { AgentNodeFsm } from "../agent-node/agent-node-fsm";
import type { AgentNodeSocket } from "../agent-node/types";
import {
  AgentNodeUnavailableError,
  EnvironmentNotFoundError,
  IllegalStateTransitionError,
  LaunchSpecBuildError,
  MachineOfflineError,
  OrchestrationError,
} from "../errors";
import { Instance } from "../instance/instance";
import { LaunchSpecBuilder } from "../launch-spec/launch-spec-builder";
import type { AgentConfigData, AgentEngineData, EnvironmentData } from "../types/deps";

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

const config: AgentConfigData = {
  id: "config-1",
  name: "writer",
  systemPrompt: null,
  modelProviderId: "provider-1",
  modelName: "model-1",
  engineId: "engine-1",
  skills: [{ skillId: "skill-1", name: "review" }],
  mcpServers: [{ mcpServerId: "mcp-1", name: "docs" }],
  knowledgeBases: [{ kbId: "kb-1", name: "handbook" }],
};

const engine: AgentEngineData = { id: "engine-1", type: "opencode", version: "1.0.0" };

function createBuilder(options?: {
  environment?: EnvironmentData | null;
  config?: AgentConfigData | null;
  engine?: AgentEngineData | null;
  workspaceRoot?: string;
}) {
  return new LaunchSpecBuilder({
    workspaceRoot: options?.workspaceRoot,
    environmentRepo: {
      getEnvironment: async () => (options?.environment === undefined ? environment : options.environment),
    },
    agentConfigRepo: { getConfig: async () => (options?.config === undefined ? config : options.config) },
    agentEngineRepo: { getEngine: async () => (options?.engine === undefined ? engine : options.engine) },
  });
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
  // LaunchSpec 会聚合环境、配置、引擎和受控 workspace 路径。
  test("构建完整 LaunchSpec", async () => {
    await expect(createBuilder({ workspaceRoot: "/data/workspaces" }).build("env-1", "user-1")).resolves.toEqual({
      environmentId: "env-1",
      agentConfig: config,
      engine,
      cwd: "/data/workspaces/org-1/user-1/env-1",
      userId: "user-1",
    });
  });

  // 未指定工作区根目录时使用稳定默认值。
  test("使用默认工作区根目录", async () => {
    await expect(createBuilder().build("env-1", "user-1")).resolves.toMatchObject({
      cwd: "workspaces/org-1/user-1/env-1",
    });
  });

  // 构建过程必须将请求用户透传给环境仓库以支持归属解析。
  test("向环境仓库透传用户标识", async () => {
    const calls: [string, string | undefined][] = [];
    const builder = new LaunchSpecBuilder({
      environmentRepo: {
        getEnvironment: async (envId, userId) => {
          calls.push([envId, userId]);
          return environment;
        },
      },
      agentConfigRepo: { getConfig: async () => config },
      agentEngineRepo: { getEngine: async () => engine },
    });

    await builder.build("env-1", "user-99");
    expect(calls).toEqual([["env-1", "user-99"]]);
  });

  // 不存在的环境应产生稳定的领域错误和诊断信息。
  test("拒绝不存在的环境", async () => {
    await expect(createBuilder({ environment: null }).build("missing", "user-1")).rejects.toMatchObject({
      code: "LAUNCH_SPEC_BUILD_FAILED",
      message: "Cannot build launch spec: environment 'missing' not found",
    });
  });

  // 未绑定 Agent 配置的环境不能生成伪成功启动配置。
  test("拒绝缺少 Agent 配置引用的环境", async () => {
    await expect(
      createBuilder({ environment: { ...environment, agentConfigId: null } }).build("env-1", "user-1"),
    ).rejects.toBeInstanceOf(LaunchSpecBuildError);
  });

  // 配置引用失效时应保留配置 ID 作为诊断上下文。
  test("拒绝不存在的 Agent 配置", async () => {
    await expect(createBuilder({ config: null }).build("env-1", "user-1")).rejects.toThrow(
      "agent config 'config-1' not found",
    );
  });

  // 空名称是缺失字段，避免生成不可识别的运行配置。
  test("拒绝空 Agent 名称", async () => {
    await expect(createBuilder({ config: { ...config, name: "" } }).build("env-1", "user-1")).rejects.toThrow("'name'");
  });

  // 空模型名是缺失字段，避免下游运行时才失败。
  test("拒绝空模型名称", async () => {
    await expect(createBuilder({ config: { ...config, modelName: "" } }).build("env-1", "user-1")).rejects.toThrow(
      "'modelName'",
    );
  });

  // 空引擎引用是缺失字段，避免访问无效引擎。
  test("拒绝空引擎引用", async () => {
    await expect(createBuilder({ config: { ...config, engineId: "" } }).build("env-1", "user-1")).rejects.toThrow(
      "'engineId'",
    );
  });

  // 不存在的引擎必须阻断启动并保留引用链路。
  test("拒绝不存在的引擎", async () => {
    await expect(createBuilder({ engine: null }).build("env-1", "user-1")).rejects.toThrow(
      "engine 'engine-1' not found",
    );
  });

  // 有效配置中的嵌套数组必须原样保留给运行时序列化。
  test("保留技能、MCP 和知识库配置", async () => {
    const spec = await createBuilder().build("env-1", "user-1");
    expect(JSON.parse(JSON.stringify(spec))).toMatchObject({
      agentConfig: { skills: config.skills, mcpServers: config.mcpServers, knowledgeBases: config.knowledgeBases },
    });
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
