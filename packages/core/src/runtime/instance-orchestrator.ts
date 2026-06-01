import type { EngineRelayHandle, EngineRuntime } from "@fenix/plugin-sdk";
import { createCoreRuntimeError } from "../errors/core-runtime-error";
import type { CoreNodeRegistry } from "../registry/core-node-registry";
import type { EnginePluginRegistry } from "../registry/engine-plugin-registry";
import type { ConnectInstanceRelayRequest, LaunchInstanceRequest } from "../types/launch-request";
import type { RuntimeInstanceSnapshot } from "../types/runtime-instance";
import type { RuntimeInstanceStore } from "./runtime-instance-store";

/**
 * Core 层对实例生命周期暴露的统一编排接口。
 */
export interface InstanceOrchestrator {
  /** 执行从创建到进入 `running` 的完整启动链路。 */
  launch(request: LaunchInstanceRequest): Promise<RuntimeInstanceSnapshot>;
  /** 为已处于运行态的实例建立或复用 relay 连接。 */
  connectRelay(request: ConnectInstanceRelayRequest): Promise<EngineRelayHandle>;
  /** 停止实例并执行必要的 relay/runtime 清理。 */
  stop(instanceId: string): Promise<void>;
  /** 读取单个实例快照；不存在时返回 `null`。 */
  get(instanceId: string): RuntimeInstanceSnapshot | null;
  /** 返回全部实例快照。 */
  list(): RuntimeInstanceSnapshot[];
}

/**
 * 创建 orchestrator 所需的依赖。
 */
export interface CreateInstanceOrchestratorOptions {
  /** 负责解析 engine plugin 的注册表。 */
  pluginRegistry: EnginePluginRegistry;
  /** 负责解析可调度 node 的注册表。 */
  nodeRegistry: CoreNodeRegistry;
  /** 负责保存实例状态与 runtime 缓存的 store。 */
  store: RuntimeInstanceStore;
  /** 实例启动完成后的回调，用于写入 pluginMetadata。 */
  onInstanceStarted?: (
    instanceId: string,
    runtime: EngineRuntime,
    updateMetadata: (metadata: Record<string, unknown>) => void,
  ) => void;
  /**
   * 自定义 runtime 创建策略。
   * 对 remote node 返回对应的 remote runtime；
   * 不提供或返回 null 时 fallback 到 plugin.createRuntime()。
   */
  runtimeResolver?: (
    engineType: string,
    node: import("../types/core-node").CoreNode,
  ) => EngineRuntime | null | Promise<EngineRuntime | null>;
}

/**
 * 创建 core 实例生命周期 orchestrator。
 */
export function createInstanceOrchestrator(options: CreateInstanceOrchestratorOptions): InstanceOrchestrator {
  const { pluginRegistry, nodeRegistry, store, onInstanceStarted, runtimeResolver } = options;

  /**
   * 把异常统一收敛为实例 `error` 状态，便于上层读取失败快照。
   */
  function markInstanceError(instanceId: string, error: unknown): void {
    const errorMessage = error instanceof Error ? error.message : String(error);
    store.update(instanceId, {
      status: "error",
      relayConnected: false,
      errorMessage,
    });
  }

  /**
   * 构造状态非法时使用的稳定错误对象。
   */
  function toInvalidStateError(instanceId: string, currentStatus: string, action: string) {
    return createCoreRuntimeError(
      "INVALID_INSTANCE_STATE",
      `Instance ${instanceId} cannot ${action} from status ${currentStatus}`,
      { instanceId, currentStatus, action },
    );
  }

  /**
   * 当 runtime 尚未成功创建记录时，补写一条错误实例快照以保留失败痕迹。
   */
  function createErroredInstanceRecord(request: LaunchInstanceRequest, error: unknown): void {
    if (!store.get(request.instanceId)) {
      store.create({
        instanceId: request.instanceId,
        engineType: request.engineType,
        nodeId: request.nodeId,
        launchSpec: request.launchSpec,
      });
    }
    markInstanceError(request.instanceId, error);
  }

  return {
    /**
     * 完整执行 prepare 和 start 两阶段，并把实例推进到 `running`。
     */
    async launch(request) {
      if (store.get(request.instanceId)) {
        throw createCoreRuntimeError(
          "INSTANCE_ALREADY_EXISTS",
          `Runtime instance already exists: ${request.instanceId}`,
          { instanceId: request.instanceId },
        );
      }

      const node = nodeRegistry.require(request.nodeId);

      if (node.status !== "online") {
        throw createCoreRuntimeError("NODE_OFFLINE", `Core node is offline: ${request.nodeId}`, {
          nodeId: request.nodeId,
        });
      }
      if (!nodeRegistry.supportsEngine(request.nodeId, request.engineType)) {
        throw createCoreRuntimeError(
          "ENGINE_NOT_SUPPORTED",
          `Core node ${request.nodeId} does not support engine ${request.engineType}`,
          {
            nodeId: request.nodeId,
            engineType: request.engineType,
          },
        );
      }

      const plugin = pluginRegistry.get(request.engineType);
      // remote node 不需要 plugin，但 local node 需要
      if (!plugin && node.mode !== "remote") {
        pluginRegistry.require(request.engineType);
      }

      let runtime: EngineRuntime;
      try {
        let resolved: EngineRuntime | null | undefined;
        if (runtimeResolver) {
          resolved = await runtimeResolver(request.engineType, node);
        }
        if (resolved) {
          runtime = resolved;
        } else if (plugin) {
          runtime = plugin.createRuntime();
        } else {
          throw createCoreRuntimeError(
            "PLUGIN_NOT_FOUND",
            `No runtime resolver and no plugin for engine ${request.engineType} on remote node ${request.nodeId}`,
            { engineType: request.engineType, nodeId: request.nodeId },
          );
        }
      } catch (error) {
        createErroredInstanceRecord(request, error);
        throw error;
      }

      store.create({
        instanceId: request.instanceId,
        engineType: request.engineType,
        nodeId: request.nodeId,
        launchSpec: request.launchSpec,
      });
      store.attachRuntime(request.instanceId, {
        plugin: node.mode === "remote" ? null : plugin,
        runtime,
        relay: null,
      });

      try {
        store.update(request.instanceId, { status: "preparing" });
        await runtime.prepareEnvironment({
          instanceId: request.instanceId,
          launchSpec: request.launchSpec,
        });
        store.update(request.instanceId, { status: "prepared" });
        store.update(request.instanceId, { status: "starting" });
        await runtime.startInstance({ instanceId: request.instanceId });
        store.update(request.instanceId, {
          status: "running",
          relayConnected: false,
        });

        // 通知上层写入 plugin 补充元数据（port, token, pid 等）
        if (onInstanceStarted) {
          onInstanceStarted(request.instanceId, runtime, (metadata) => {
            store.update(request.instanceId, { pluginMetadata: metadata });
          });
        }

        return store.require(request.instanceId);
      } catch (error) {
        markInstanceError(request.instanceId, error);
        throw error;
      }
    },

    /**
     * 仅允许 `running` 态实例建立 relay，并优先复用已打开的连接。
     */
    async connectRelay(request) {
      store.require(request.instanceId);

      try {
        const record = store.require(request.instanceId);
        if (record.status !== "running") {
          throw toInvalidStateError(request.instanceId, record.status, "connectRelay");
        }

        const runtimeEntry = store.getRuntimeEntry(request.instanceId);
        if (!runtimeEntry) {
          throw createCoreRuntimeError("INSTANCE_NOT_FOUND", `Runtime entry not found: ${request.instanceId}`, {
            instanceId: request.instanceId,
          });
        }

        if (runtimeEntry.relay && runtimeEntry.relay.state === "open") {
          return runtimeEntry.relay;
        }

        const relay = await runtimeEntry.runtime.connectRelay({
          instanceId: request.instanceId,
          sessionId: request.sessionId,
        });
        store.setRelay(request.instanceId, relay);
        return relay;
      } catch (error) {
        markInstanceError(request.instanceId, error);
        throw error;
      }
    },

    /**
     * 停止实例；对已停止实例保持幂等。
     */
    async stop(instanceId) {
      const record = store.require(instanceId);
      if (record.status === "stopped") {
        return;
      }

      try {
        store.update(instanceId, { status: "stopping" });
        const runtimeEntry = store.getRuntimeEntry(instanceId);
        if (!runtimeEntry) {
          throw createCoreRuntimeError("INSTANCE_NOT_FOUND", `Runtime entry not found: ${instanceId}`, { instanceId });
        }

        if (runtimeEntry.relay?.state === "open") {
          await runtimeEntry.relay.close();
        }
        await runtimeEntry.runtime.stopInstance({ instanceId });
        store.clearRelay(instanceId);
        store.update(instanceId, {
          status: "stopped",
          relayConnected: false,
        });
      } catch (error) {
        markInstanceError(instanceId, error);
        throw error;
      }
    },

    /**
     * 透传读取单个实例快照。
     */
    get(instanceId) {
      return store.get(instanceId);
    },

    /**
     * 透传读取全部实例快照。
     */
    list() {
      return store.list();
    },
  };
}
