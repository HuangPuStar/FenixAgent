/**
 * AgentController 子域测试：spawnInstance 完整编排、错误映射、Instance send/stop、listInstances。
 *
 * 全部通过 mock 注入（内存 Repo / MockSocket / MockAgentNodeService），不依赖真实 DB、WS
 * 或 Agent 进程；直接构造注入，禁止 mock.module()。LaunchSpecBuilder 使用真实实现，
 * 其 Repo 依赖以内存 mock 注入。
 */

import { describe, expect, test } from "bun:test";
import { AgentController } from "../src/agent-controller";
import { AgentNode } from "../src/agent-node/agent-node";
import type { AgentNodeSocket } from "../src/agent-node/types";
import {
  AgentNodeUnavailableError,
  ConcurrencyExceededError,
  EnvironmentNotFoundError,
  LaunchSpecBuildError,
  OrchestrationError,
} from "../src/errors";
import { Instance } from "../src/instance/instance";
import { LaunchSpecBuilder } from "../src/launch-spec/launch-spec-builder";
import type {
  AgentConfigData,
  AgentConfigRepo,
  AgentEngineData,
  AgentEngineRepo,
  EnvironmentData,
  EnvironmentRepo,
} from "../src/types/deps";

/** Mock WS 信道：记录发送数据，可手动触发 open/close/error 事件。 */
class MockSocket implements AgentNodeSocket {
  sent: unknown[] = [];
  closed = false;
  #openHandler: (() => void) | null = null;
  #closeHandler: (() => void) | null = null;
  #errorHandler: (() => void) | null = null;

  onOpen(handler: () => void): void {
    this.#openHandler = handler;
  }

  onClose(handler: () => void): void {
    this.#closeHandler = handler;
  }

  onError(handler: () => void): void {
    this.#errorHandler = handler;
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.#closeHandler?.();
  }

  simulateOpen(): void {
    this.#openHandler?.();
  }

  simulateError(): void {
    this.#errorHandler?.();
  }
}

/** 内存版环境仓库：仅按 ID 返回预置数据，无持久化。 */
class MockEnvironmentRepo implements EnvironmentRepo {
  readonly envs = new Map<string, EnvironmentData>();

  getEnvironment(envId: string): Promise<EnvironmentData | null> {
    return Promise.resolve(this.envs.get(envId) ?? null);
  }
}

/** 内存版 Agent 配置仓库：仅按 ID 返回预置数据，无持久化。 */
class MockAgentConfigRepo implements AgentConfigRepo {
  readonly configs = new Map<string, AgentConfigData>();

  getConfig(configId: string): Promise<AgentConfigData | null> {
    return Promise.resolve(this.configs.get(configId) ?? null);
  }
}

/** 内存版引擎仓库：仅按 ID 返回预置数据，无持久化。 */
class MockAgentEngineRepo implements AgentEngineRepo {
  readonly engines = new Map<string, AgentEngineData>();

  getEngine(engineId: string): Promise<AgentEngineData | null> {
    return Promise.resolve(this.engines.get(engineId) ?? null);
  }
}

/** Mock AgentNodeService：从预置节点表返回 AgentNode，缺失时抛 AgentNodeUnavailableError。 */
class MockAgentNodeService {
  readonly nodes = new Map<string, AgentNode>();
  readonly released = new Set<string>();

  ensureNode(machineId: string): AgentNode {
    const node = this.nodes.get(machineId);
    if (node === undefined) {
      throw new AgentNodeUnavailableError(`Agent node for machine ${machineId} is unavailable`);
    }
    return node;
  }

  releaseNode(machineId: string): void {
    this.released.add(machineId);
  }
}

/** 构建一个已 connected 的 AgentNode（真实 FSM + Mock WS 信道）。 */
function createConnectedNode(machineId: string): { node: AgentNode; socket: MockSocket } {
  const socket = new MockSocket();
  const node = new AgentNode({ machineId, socket, maxRetries: 0 });
  node._handleConnected();
  return { node, socket };
}

/** 标准测试夹具：预置 env/cfg/engine/machine 数据，返回注入好依赖的 controller。 */
function setup() {
  const envRepo = new MockEnvironmentRepo();
  const configRepo = new MockAgentConfigRepo();
  const engineRepo = new MockAgentEngineRepo();
  const nodeService = new MockAgentNodeService();

  envRepo.envs.set("env1", {
    id: "env1",
    organizationId: "org1",
    agentConfigId: "cfg1",
    machineId: "m1",
    maxConcurrency: 1,
    autoStart: true,
  });
  configRepo.configs.set("cfg1", {
    id: "cfg1",
    name: "demo",
    systemPrompt: null,
    modelProviderId: "prov1",
    modelName: "gpt-4o",
    engineId: "engine1",
    skills: [],
    mcpServers: [],
    knowledgeBases: [],
  });
  engineRepo.engines.set("engine1", { id: "engine1", type: "opencode", version: "1.0" });

  const { node, socket } = createConnectedNode("m1");
  nodeService.nodes.set("m1", node);

  const builder = new LaunchSpecBuilder({
    agentConfigRepo: configRepo,
    environmentRepo: envRepo,
    agentEngineRepo: engineRepo,
  });
  const controller = new AgentController({
    agentNodeService: nodeService,
    launchSpecBuilder: builder,
    environmentRepo: envRepo,
  });

  return { controller, envRepo, configRepo, engineRepo, nodeService, node, socket };
}

describe("AgentController.spawnInstance", () => {
  test("正常 spawn：完整流程返回 Instance，状态 running，快照字段正确", async () => {
    const { controller, socket } = setup();

    const instance = await controller.spawnInstance("env1", "user1");

    expect(instance).toBeInstanceOf(Instance);
    expect(instance.instanceId).toMatch(/^inst_/);
    expect(instance.status()).toBe("running");
    expect(instance.info()).toEqual({
      instanceId: instance.instanceId,
      environmentId: "env1",
      agentConfigId: "cfg1",
      machineId: "m1",
      status: "running",
    });
    expect(socket.closed).toBe(false);
  });

  test("并发超限：maxConcurrency=1 时第二次 spawnInstance 抛 ConcurrencyExceededError", async () => {
    const { controller } = setup();

    await controller.spawnInstance("env1", "user1");
    expect(controller.listInstances()).toHaveLength(1);

    await expect(controller.spawnInstance("env1", "user1")).rejects.toThrow(ConcurrencyExceededError);
  });

  test("Machine 不可用：ensureNode 无对应 AgentNode 时抛 AgentNodeUnavailableError", async () => {
    const { controller, nodeService } = setup();
    nodeService.nodes.delete("m1"); // 模拟机器未连接

    await expect(controller.spawnInstance("env1", "user1")).rejects.toThrow(AgentNodeUnavailableError);
  });

  test("envId 不存在：environmentRepo 返回 null 时抛 EnvironmentNotFoundError", async () => {
    const { controller } = setup();

    await expect(controller.spawnInstance("ghost-env", "user1")).rejects.toThrow(EnvironmentNotFoundError);
  });

  test("LaunchSpec 缺失字段：agentConfig 无 modelName 时抛 LaunchSpecBuildError", async () => {
    const { controller, configRepo } = setup();
    configRepo.configs.get("cfg1")!.modelName = "";

    await expect(controller.spawnInstance("env1", "user1")).rejects.toThrow(LaunchSpecBuildError);
  });

  test("环境缺少 machineId：配置视为不完整，抛 LaunchSpecBuildError", async () => {
    const { controller, envRepo } = setup();
    envRepo.envs.get("env1")!.machineId = null;

    await expect(controller.spawnInstance("env1", "user1")).rejects.toThrow(LaunchSpecBuildError);
  });
});

describe("Instance send / stop", () => {
  test("Instance send：数据经 AgentNode WS 信道原样发送", async () => {
    const { controller, socket } = setup();

    const instance = await controller.spawnInstance("env1", "user1");
    instance.send({ type: "ping", seq: 1 });

    expect(socket.sent).toEqual([{ type: "ping", seq: 1 }]);
  });

  test("Instance stop：发送停止帧通知 Agent 进程并标记终止，不关闭共享连接，状态变为 stopped", async () => {
    const { controller, socket } = setup();

    const instance = await controller.spawnInstance("env1", "user1");
    instance.stop();

    // 停止帧携带 instance_id（机器端协议字段），供同一连接上的 Agent 进程识别目标实例
    expect(socket.sent).toEqual([{ type: "stop", instance_id: instance.instanceId }]);
    expect(socket.closed).toBe(false); // 共享连接不被关闭，避免影响同一节点的其他实例
    expect(instance.status()).toBe("stopped");
  });

  test("Instance 断连映射：AgentNode 意外断连（WS error）时状态推导为 error", async () => {
    const { controller, socket } = setup();

    const instance = await controller.spawnInstance("env1", "user1");
    socket.simulateError(); // 错误按断连处理 → disconnected

    expect(instance.status()).toBe("error");
  });
});

describe("AgentController.stopInstance / listInstances", () => {
  test("listInstances：多次 spawn 后返回全部活跃实例，包含正确的实例信息", async () => {
    const { controller, envRepo } = setup();
    envRepo.envs.get("env1")!.maxConcurrency = 3; // 放宽并发限制以便同时承载多个实例

    const spawned = [
      await controller.spawnInstance("env1", "user1"),
      await controller.spawnInstance("env1", "user1"),
      await controller.spawnInstance("env1", "user1"),
    ];
    const listed = controller.listInstances();

    expect(listed).toHaveLength(3);
    expect(listed.map((i) => i.instanceId).sort()).toEqual(spawned.map((i) => i.instanceId).sort());
    expect(listed.every((i) => i.environmentId === "env1" && i.status() === "running")).toBe(true);
  });

  test("stopInstance：停止实例后归还节点引用并从活跃列表移除；重复停止抛 OrchestrationError", async () => {
    const { controller, envRepo, nodeService } = setup();
    envRepo.envs.get("env1")!.maxConcurrency = 2;

    const a = await controller.spawnInstance("env1", "user1");
    await controller.spawnInstance("env1", "user1");
    expect(controller.listInstances()).toHaveLength(2);

    await controller.stopInstance(a.instanceId);
    expect(controller.listInstances()).toHaveLength(1);
    expect(a.status()).toBe("stopped");
    expect(nodeService.released.has("m1")).toBe(true); // 引用已归还，等待空闲回收

    // 已停止的实例不再占用并发额度，可以再次 spawn
    const c = await controller.spawnInstance("env1", "user1");
    expect(controller.listInstances()).toHaveLength(2);
    expect(c.instanceId).not.toBe(a.instanceId);

    await expect(controller.stopInstance(a.instanceId)).rejects.toThrow(OrchestrationError);
  });
});
