import type { EnginePlugin, EngineRelayHandle } from "@mothership/plugin-sdk";
import { CoreNodeRegistry } from "../registry/core-node-registry";
import { EnginePluginRegistry } from "../registry/engine-plugin-registry";
import { createInstanceOrchestrator } from "../runtime/instance-orchestrator";
import {
  createRuntimeInstanceStore,
  type RuntimeInstanceStore,
} from "../runtime/runtime-instance-store";
import type {
  ConnectInstanceRelayRequest,
  LaunchInstanceRequest,
} from "../types/launch-request";
import type {
  CoreNode,
  CreateCoreNodeInput,
} from "../types/core-node";
import type { RuntimeInstanceSnapshot } from "../types/runtime-instance";

/**
 * Core 对外暴露的稳定 facade。
 */
export interface CoreRuntimeFacade {
  /** 注册一个 engine plugin，供后续实例调度使用。 */
  registerPlugin(plugin: EnginePlugin): EnginePlugin;
  /** 注册一个可调度 node。 */
  registerNode(node: CreateCoreNodeInput): CoreNode;
  /** 启动一个实例直到进入 `running`。 */
  launchInstance(request: LaunchInstanceRequest): Promise<RuntimeInstanceSnapshot>;
  /** 为实例建立或复用 relay 连接。 */
  connectInstanceRelay(
    request: ConnectInstanceRelayRequest,
  ): Promise<EngineRelayHandle>;
  /** 停止指定实例。 */
  stopInstance(instanceId: string): Promise<void>;
  /** 查询单个实例快照；不存在时返回 `null`。 */
  getInstance(instanceId: string): RuntimeInstanceSnapshot | null;
  /** 查询全部实例快照。 */
  listInstances(): RuntimeInstanceSnapshot[];
  /** 查询单个 node；不存在时返回 `null`。 */
  getNode(nodeId: string): CoreNode | null;
  /** 查询全部已注册 node。 */
  listNodes(): CoreNode[];
  /** 查询单个 plugin；不存在时返回 `null`。 */
  getPlugin(engineType: string): EnginePlugin | null;
  /** 查询全部已注册 plugin。 */
  listPlugins(): EnginePlugin[];
}

/**
 * 创建 core runtime facade 的可选装配项。
 */
export interface CreateCoreRuntimeOptions {
  /** 创建时预注册的插件列表。 */
  plugins?: EnginePlugin[];
  /** 创建时预注册的 node 列表。 */
  nodes?: CreateCoreNodeInput[];
  /** 可选的自定义实例 store，主要用于测试或替换存储实现。 */
  store?: RuntimeInstanceStore;
}

/**
 * 创建 `@mothership/core` 的唯一公开运行时入口。
 */
export function createCoreRuntime(
  options?: CreateCoreRuntimeOptions,
): CoreRuntimeFacade {
  const pluginRegistry = new EnginePluginRegistry();
  const nodeRegistry = new CoreNodeRegistry();
  const instanceStore = options?.store ?? createRuntimeInstanceStore();
  const orchestrator = createInstanceOrchestrator({
    pluginRegistry,
    nodeRegistry,
    store: instanceStore,
  });

  for (const plugin of options?.plugins ?? []) {
    pluginRegistry.register(plugin);
  }
  for (const node of options?.nodes ?? []) {
    nodeRegistry.register(node);
  }

  return {
    /** 注册并返回 plugin，便于上层在装配阶段链式使用。 */
    registerPlugin(plugin) {
      return pluginRegistry.register(plugin);
    },
    /** 注册并返回 node 副本。 */
    registerNode(node) {
      return nodeRegistry.register(node);
    },
    /** 委托 orchestrator 执行完整启动链路。 */
    launchInstance(request) {
      return orchestrator.launch(request);
    },
    /** 委托 orchestrator 建立或复用 relay。 */
    connectInstanceRelay(request) {
      return orchestrator.connectRelay(request);
    },
    /** 委托 orchestrator 停止实例。 */
    stopInstance(instanceId) {
      return orchestrator.stop(instanceId);
    },
    /** 查询单个实例快照。 */
    getInstance(instanceId) {
      return orchestrator.get(instanceId);
    },
    /** 查询全部实例快照。 */
    listInstances() {
      return orchestrator.list();
    },
    /** 查询单个 node。 */
    getNode(nodeId) {
      return nodeRegistry.get(nodeId);
    },
    /** 查询全部 node。 */
    listNodes() {
      return nodeRegistry.list();
    },
    /** 查询单个 plugin。 */
    getPlugin(engineType) {
      return pluginRegistry.get(engineType);
    },
    /** 查询全部 plugin。 */
    listPlugins() {
      return pluginRegistry.list();
    },
  };
}
