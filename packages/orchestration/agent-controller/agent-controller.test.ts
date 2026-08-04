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
import { AgentNodeService } from "../src/agent-node/agent-node-service";
import type { AgentNodeSocket, TimerScheduler } from "../src/agent-node/types";
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
  /** 模拟宿主 Repo（environment-orchestration.ts）的默认机器 fallback：machineId 为空时回退到该值。 */
  defaultMachineId: string | null = null;

  getEnvironment(envId: string): Promise<EnvironmentData | null> {
    const env = this.envs.get(envId) ?? null;
    // 模拟宿主 Repo 的空串/空值归一：未绑定 machineId 时回退默认机器。
    // 编排域不读取环境变量，fallback 责任全部在宿主 Repo，此处仅还原其对外语义。
    if (env !== null && !env.machineId && this.defaultMachineId !== null) {
      return Promise.resolve({ ...env, machineId: this.defaultMachineId });
    }
    return Promise.resolve(env);
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
  /** 每台机器的引用归还次数（Map 计数而非 Set 去重：断言"每实例归还一次"）。 */
  readonly releasedCounts = new Map<string, number>();

  ensureNode(machineId: string): AgentNode {
    const node = this.nodes.get(machineId);
    if (node === undefined) {
      throw new AgentNodeUnavailableError(`Agent node for machine ${machineId} is unavailable`);
    }
    return node;
  }

  releaseNode(machineId: string): void {
    this.releasedCounts.set(machineId, (this.releasedCounts.get(machineId) ?? 0) + 1);
  }
}

/** Mock 定时器：任务手动触发，支持取消标记（语义与 agent-node-service.test.ts 一致）。 */
class MockScheduler implements TimerScheduler {
  #tasks: { handler: () => void; cancelled: boolean }[] = [];

  setTimeout(handler: () => void): unknown {
    const task = { handler, cancelled: false };
    this.#tasks.push(task);
    return task;
  }

  clearTimeout(handle: unknown): void {
    (handle as { cancelled: boolean }).cancelled = true;
  }

  /** 触发下一个未取消的任务，返回是否真的有任务被执行。 */
  fireNext(): boolean {
    const task = this.#tasks.find((t) => !t.cancelled);
    if (task === undefined) {
      return false;
    }
    task.cancelled = true;
    task.handler();
    return true;
  }
}

/** 构建一个已 connected 的 AgentNode（真实 FSM + Mock WS 信道）。 */
function createConnectedNode(machineId: string): { node: AgentNode; socket: MockSocket } {
  const socket = new MockSocket();
  const node = new AgentNode({ machineId, socket, maxRetries: 0 });
  node._handleConnected();
  return { node, socket };
}

/** 预置 env1/cfg1/engine1 标准数据（setup 与真实节点服务夹具共用）。 */
function seedStandardData(
  envRepo: MockEnvironmentRepo,
  configRepo: MockAgentConfigRepo,
  engineRepo: MockAgentEngineRepo,
): void {
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
}

/** 标准测试夹具：预置 env/cfg/engine/machine 数据，返回注入好依赖的 controller。 */
function setup() {
  const envRepo = new MockEnvironmentRepo();
  const configRepo = new MockAgentConfigRepo();
  const engineRepo = new MockAgentEngineRepo();
  const nodeService = new MockAgentNodeService();

  seedStandardData(envRepo, configRepo, engineRepo);

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

/**
 * 真实 AgentNodeService 夹具：机器 m1 已通过 handleIncomingConnection 连接
 * （引用计数 0），返回注入真实节点服务的 controller，供空闲回收 / 停止帧用例使用。
 */
function setupWithRealNodeService(scheduler: TimerScheduler): {
  controller: AgentController;
  service: AgentNodeService;
  socket: MockSocket;
  envRepo: MockEnvironmentRepo;
} {
  const service = new AgentNodeService({
    idleTimeoutMs: 100,
    maxRetries: 0,
    reconnectDelayMs: 10,
    scheduler,
  });
  const socket = new MockSocket();
  service.handleIncomingConnection("m1", socket);

  const envRepo = new MockEnvironmentRepo();
  const configRepo = new MockAgentConfigRepo();
  const engineRepo = new MockAgentEngineRepo();
  seedStandardData(envRepo, configRepo, engineRepo);

  const builder = new LaunchSpecBuilder({
    agentConfigRepo: configRepo,
    environmentRepo: envRepo,
    agentEngineRepo: engineRepo,
  });
  const controller = new AgentController({
    agentNodeService: service,
    launchSpecBuilder: builder,
    environmentRepo: envRepo,
  });

  return { controller, service, socket, envRepo };
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

  test("环境缺少 machineId 且宿主无默认机器：编排域以配置错误拒绝，抛 LaunchSpecBuildError", async () => {
    // 断裂点 4 修复后，宿主 Repo 负责把空串/空 machineId 归一到 fallback 链；
    // 此用例覆盖宿主 fallback 后仍为 null 的场景（禁用本地执行且无默认机器），
    // 此时编排域不再有任何可执行节点，以配置错误拒绝启动（防御性兜底）。
    const { controller, envRepo } = setup();
    envRepo.envs.get("env1")!.machineId = null; // 宿主 fallback 后仍无机器（本地执行被禁用）

    await expect(controller.spawnInstance("env1", "user1")).rejects.toThrow(LaunchSpecBuildError);
  });

  test("环境缺少 machineId 但宿主提供默认机器：fallback 到默认机器正常 spawn", async () => {
    // 模拟宿主 Repo（environment-orchestration.ts）的 defaultMachineId fallback：
    // agent config 未绑定 machineId 时回退到 RCS_DEFAULT_MACHINE_ID 指定机器，
    // 而不是直接抛配置错误（对齐 getRemoteMachineId 的节点选择语义）。
    const { controller, envRepo } = setup();
    envRepo.defaultMachineId = "m1"; // 宿主 RCS_DEFAULT_MACHINE_ID
    envRepo.envs.get("env1")!.machineId = null; // agent config 未绑定 machineId

    const instance = await controller.spawnInstance("env1", "user1");

    expect(instance.machineId).toBe("m1");
    expect(instance.status()).toBe("running");
  });

  test("无 agentConfigId 环境：不再被 EnvironmentNotFoundError 拒绝，错误下沉为 LaunchSpecBuildError", async () => {
    // 断裂点 5 修复后，宿主 Repo 对无 agentConfigId 环境（ACP/Bridge 注册路径创建）
    // 返回数据而非 null；agentConfig 必填约束由 LaunchSpecBuilder 在 spawn 层兜底，
    // 因此错误从 404（EnvironmentNotFoundError）变为 422（LaunchSpecBuildError），
    // 不再把"未绑定配置"误判为"环境不存在"。
    const { controller, envRepo } = setup();
    envRepo.envs.set("env-acp", {
      id: "env-acp",
      organizationId: "org1",
      agentConfigId: null, // ACP/Bridge 注册路径创建的环境无 agentConfigId
      machineId: "m1",
      maxConcurrency: 1,
      autoStart: false,
    });

    await expect(controller.spawnInstance("env-acp", "user1")).rejects.toThrow(LaunchSpecBuildError);
    await expect(controller.spawnInstance("env-acp", "user1")).rejects.not.toThrow(EnvironmentNotFoundError);
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
    expect(nodeService.releasedCounts.get("m1")).toBe(1); // 引用已归还，等待空闲回收

    // 已停止的实例不再占用并发额度，可以再次 spawn
    const c = await controller.spawnInstance("env1", "user1");
    expect(controller.listInstances()).toHaveLength(2);
    expect(c.instanceId).not.toBe(a.instanceId);

    await expect(controller.stopInstance(a.instanceId)).rejects.toThrow(OrchestrationError);
  });
});

describe("AgentController.stopInstancesByMachineId", () => {
  test("清理目标机器全部实例并每实例归还一次节点引用", async () => {
    const { controller, envRepo, nodeService } = setup();
    envRepo.envs.get("env1")!.maxConcurrency = 2; // 放宽并发限制以便同机器承载 2 个实例
    envRepo.envs.set("env2", {
      id: "env2",
      organizationId: "org1",
      agentConfigId: "cfg1",
      machineId: "m2",
      maxConcurrency: 1,
      autoStart: true,
    });
    const { node: node2 } = createConnectedNode("m2");
    nodeService.nodes.set("m2", node2);

    const m1a = await controller.spawnInstance("env1", "user1");
    const m1b = await controller.spawnInstance("env1", "user1");
    const m2 = await controller.spawnInstance("env2", "user1");
    expect(controller.listInstances()).toHaveLength(3);

    const removed = controller.stopInstancesByMachineId("m1");

    // 只清理 m1 的实例，m2 实例保留；每个实例归还一次节点引用（计数而非去重）
    expect(removed).toBe(2);
    expect(controller.listInstances().map((i) => i.instanceId)).toEqual([m2.instanceId]);
    expect(m1a.status()).toBe("stopped");
    expect(m1b.status()).toBe("stopped");
    expect(nodeService.releasedCounts.get("m1")).toBe(2);
    expect(nodeService.releasedCounts.get("m2")).toBeUndefined();
  });

  test("无匹配机器时返回 0 且不抛错", async () => {
    const { controller } = setup();
    await controller.spawnInstance("env1", "user1");

    // m2 机器无任何实例：批量清理无"目标不存在"概念，返回 0 且不抛错
    expect(controller.stopInstancesByMachineId("m2")).toBe(0);
    expect(controller.listInstances()).toHaveLength(1);
  });

  test("重复调用幂等：第二次调用返回 0 且不抛错", async () => {
    const { controller, envRepo, nodeService } = setup();
    envRepo.envs.get("env1")!.maxConcurrency = 2;
    await controller.spawnInstance("env1", "user1");
    await controller.spawnInstance("env1", "user1");

    expect(controller.stopInstancesByMachineId("m1")).toBe(2);
    // 活跃表已空：重复清理幂等返回 0（宿主断连/心跳超时先后触发时不会重复计数）
    expect(controller.stopInstancesByMachineId("m1")).toBe(0);
    expect(nodeService.releasedCounts.get("m1")).toBe(2);
  });

  test("节点已断开时清理不发停止帧", async () => {
    const { controller, service, socket } = setupWithRealNodeService(new MockScheduler());
    const instance = await controller.spawnInstance("env1", "user1");

    socket.close(); // 模拟机器断连（dispatchAgentNodeWsClose → disconnected）
    expect(instance.status()).toBe("error");

    controller.stopInstancesByMachineId("m1");

    // 断连后节点非 connected，stop() 的停止帧发送门禁（instance.ts）不触发
    expect(socket.sent).toEqual([]);
    expect(controller.listInstances()).toHaveLength(0);
    expect(service.activeCount()).toBe(1); // 节点仍在管理集合，等待引用归零后的空闲回收
  });

  test("节点 connected 时清理发送停止帧（复用 stopInstance 语义）", async () => {
    const { controller, socket } = setupWithRealNodeService(new MockScheduler());
    const instance = await controller.spawnInstance("env1", "user1");

    controller.stopInstancesByMachineId("m1");

    // 停止帧携带 instance_id（机器端协议字段），与 stopInstance 语义一致
    expect(socket.sent).toEqual([{ type: "stop", instance_id: instance.instanceId }]);
    expect(instance.status()).toBe("stopped");
  });

  test("引用归零后空闲回收触发并关闭节点（幽灵实例解毒）", async () => {
    const scheduler = new MockScheduler();
    const { controller, service, socket, envRepo } = setupWithRealNodeService(scheduler);
    envRepo.envs.get("env1")!.maxConcurrency = 2;

    await controller.spawnInstance("env1", "user1");
    await controller.spawnInstance("env1", "user1");
    socket.close(); // 模拟机器断连
    controller.stopInstancesByMachineId("m1");
    expect(service.activeCount()).toBe(1); // 节点尚未被空闲回收

    // 引用归零后空闲回收定时器启动：触发后节点关闭并移出管理集合（不再滞留）
    expect(scheduler.fireNext()).toBe(true);
    expect(service.activeCount()).toBe(0);
  });
});
