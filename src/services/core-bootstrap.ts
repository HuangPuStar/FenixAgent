import { createEnginePlugin as createCcbPlugin } from "@fenix/ccb";
import { createClaudeCodePlugin } from "@fenix/claude-code";
import { type CoreRuntimeFacade, createCoreRuntime } from "@fenix/core";
import { log } from "@fenix/logger";
import { createEnginePlugin as createOpencodePlugin } from "@fenix/opencode";
import {
  createRemoteRuntime,
  createWsRemoteTransport,
  type RemoteTransport,
  type WsConnectionLike,
} from "@fenix/remote-runtime";
import { config } from "../config";
import type { WsConnection } from "../transport/ws-types";
import type { AcpConnectionEntry } from "../types/store";
import { globalInstanceRegistry } from "./instance-registry";

let facade: CoreRuntimeFacade | null = null;

// 缓存远程 transport 实例
const remoteTransports = new Map<string, RemoteTransport>();

function defaultCreateFacade(): CoreRuntimeFacade {
  return createCoreRuntime({
    plugins: [createOpencodePlugin(), createClaudeCodePlugin(), createCcbPlugin()],
    nodes: config.disableLocalExecution
      ? []
      : [
          {
            id: "local-default",
            mode: "local",
            engineTypes: ["opencode", "claude-code", "ccb"],
            status: "online",
          },
        ],
    onInstanceStarted(_instanceId, _runtime, _updateMetadata) {
      // port/token/pid 由 AcpLinkProcessManager 写入 pluginMetadata
    },
    runtimeResolver(_engineType, node) {
      if (node.mode === "remote") {
        const cached = remoteTransports.get(node.id);
        if (cached) {
          return createRemoteRuntime({ transport: cached });
        }
      }
      return null;
    },
  });
}

/** 可替换的 facade 工厂（测试时注入 mock） */
let _facadeFactory: (() => CoreRuntimeFacade) | null = null;

/**
 * 获取全局 CoreRuntimeFacade 单例。
 * 首次调用时初始化：注册 opencode plugin + local node + onInstanceStarted 回调。
 *
 * 更换引擎时只需修改此文件：替换 plugin 和 onInstanceStarted 回调，
 * instance.ts 和 relay handler 层无需改动。
 */
export function getCoreRuntime(): CoreRuntimeFacade {
  if (!facade) {
    facade = _facadeFactory ? _facadeFactory() : defaultCreateFacade();
  }
  return facade;
}

/** 测试用：注入自定义 facade 工厂。传 null 恢复默认。 */
export function setCoreRuntimeFactory(fn: (() => CoreRuntimeFacade) | null) {
  _facadeFactory = fn;
  facade = null;
}

/** 重置单例（仅用于测试）。 */
export function resetCoreRuntime(): void {
  facade = null;
}

/**
 * 远程 machine 注册成功后，动态注册 remote node 到 core。
 * @param acpEntry 对应的 AcpConnectionEntry，用于在消息路由时注入到 transport
 */
export function registerRemoteNode(
  machineId: string,
  ws: WsConnection,
  acpEntry: AcpConnectionEntry,
  engineTypes?: string[],
): void {
  const runtime = getCoreRuntime();

  // WsConnection 没有 onmessage，通过 injectMessage 由 handleAcpWsMessage 路由
  const wsLike = ws as unknown as WsConnectionLike;
  const transport = createWsRemoteTransport(wsLike);
  remoteTransports.set(machineId, transport);

  // 把 transport 挂到 entry 上，供 handleAcpWsMessage 路由消息
  acpEntry.remoteTransport = transport;

  const existing = runtime.getNode(machineId);
  if (existing) {
    // node 已存在（重连场景）：更新状态为 online，清理旧实例以触发重新 launch
    runtime.updateNodeStatus(machineId, "online");
    // 删除该 machineId 下所有旧实例，确保下次 ensureRunning 重新 launch
    for (const instance of runtime.listInstances()) {
      if (instance.nodeId !== machineId) continue;
      runtime.deleteInstance(instance.instanceId);
      // 同步清理 RCS 业务层 registry，否则 ensureRunning 会 reuse 已失效实例
      globalInstanceRegistry.unregister(instance.instanceId);
      log(`[core-bootstrap] Deleted instance ${instance.instanceId} on reconnected machine ${machineId}`);
    }
    // 注意：不关闭 relay 连接，让前端自动重连 ensureRunning 时使用新 transport
    return;
  }

  runtime.registerNode({
    id: machineId,
    mode: "remote",
    engineTypes: engineTypes ?? ["opencode"],
    status: "online",
    metadata: { machineId },
  });
}

/**
 * 远程 machine 断连后，清理 transport 缓存并更新 node 状态为 offline。
 * 同时删除该 machineId 下的所有活跃实例记录，使后续 ensureRunning 能重新 launch。
 */
export function unregisterRemoteNode(machineId: string): void {
  remoteTransports.delete(machineId);
  const runtime = getCoreRuntime();
  const existing = runtime.getNode(machineId);
  if (existing) {
    runtime.updateNodeStatus(machineId, "offline");
  }
  // 删除该 machineId 下所有活跃实例，让 ensureRunning 重新 launch
  for (const instance of runtime.listInstances()) {
    if (instance.nodeId !== machineId) continue;
    runtime.deleteInstance(instance.instanceId);
    log(`[core-bootstrap] Deleted instance ${instance.instanceId} on disconnected machine ${machineId}`);
  }
}
