import { getBoundAgentRuntime } from "@fenix/agent-runtime/runtime";
import { createEnginePlugin as createCcbPlugin } from "@fenix/ccb";
import { createClaudeCodePlugin } from "@fenix/claude-code";
import { type CoreRuntimeFacade, createCoreRuntime } from "@fenix/core";
import { createEnginePlugin as createOpencodePlugin } from "@fenix/opencode";
import { createEnginePlugin as createPeriPlugin } from "@fenix/peri";
import {
  createRemoteRuntime,
  createWsRemoteTransport,
  type RemoteTransport,
  SERVER_EPOCH,
  type WsConnectionLike,
} from "@fenix/remote-runtime";
import { ensureDefaultMachine } from "@fenix/resource-machine/server";
import { config } from "../config";

let facade: CoreRuntimeFacade | null = null;

// 缓存远程 transport 实例
const remoteTransports = new Map<string, RemoteTransport>();

function defaultCreateFacade(): CoreRuntimeFacade {
  return createCoreRuntime({
    plugins: [createOpencodePlugin(), createClaudeCodePlugin(), createCcbPlugin(), createPeriPlugin()],
    nodes: config.disableLocalExecution
      ? []
      : [
          {
            id: "local-default",
            mode: "local",
            engineTypes: ["opencode", "claude-code", "ccb", "peri"],
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
          return createRemoteRuntime({ transport: cached, serverEpoch: SERVER_EPOCH });
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
 * 首次调用时初始化：注册各引擎 plugin + local node + onInstanceStarted 回调。
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
 * 初始化 core runtime（含部署兜底机器记录的补齐）。
 * 应在服务启动时调用，替代直接调用 getCoreRuntime()。
 */
export async function initCoreRuntime(): Promise<CoreRuntimeFacade> {
  // `machine` 表归 machine 包，此处只提供部署值（兜底机器 ID 与引擎类型都来自宿主 env）：
  // 记录不存在时补一条 pending 记录，注册时再来认领。
  if (config.defaultMachineId) {
    await ensureDefaultMachine({
      machineId: config.defaultMachineId,
      // 兜底引擎类型与本地执行默认引擎保持一致（见 orchestration-instance 的本地 launch 分支）
      agentName: config.defaultEngineType ?? "peri",
    });
  }
  return getCoreRuntime();
}

/**
 * 远程 machine 注册成功后，动态注册 remote node 到 core。
 * @param acpEntry 对应的 AcpConnectionEntry，用于在消息路由时注入到 transport
 */
export function registerRemoteNode(
  machineId: string,
  ws: WsConnectionLike,
  acpEntry: { remoteTransport?: RemoteTransport },
  engineTypes?: string[],
): void {
  const runtime = getCoreRuntime();

  // WsConnection 没有 onmessage，通过 injectMessage 由 handleAcpWsMessage 路由
  const transport = createWsRemoteTransport(ws);
  remoteTransports.set(machineId, transport);

  // 把 transport 挂到 entry 上，供 handleAcpWsMessage 路由消息
  acpEntry.remoteTransport = transport;

  const existing = runtime.getNode(machineId);
  if (existing) {
    // node 已存在（重连场景）：更新状态为 online，清理旧实例以触发重新 launch
    runtime.updateNodeStatus(machineId, "online");
    // 该 machineId 下的旧 core 实例连同实例登记表、编排域活跃表一并收敛，确保下次 ensureRunning
    // 重新 launch（E-P0.1：快速重连短路场景下本分支是幽灵实例清理的唯一入口）
    getBoundAgentRuntime().cleanupMachineInstances(machineId);
    // 注意：不关闭 relay 连接，让前端自动重连 ensureRunning 时使用新 transport
    return;
  }

  runtime.registerNode({
    id: machineId,
    mode: "remote",
    // 未声明引擎清单的节点按平台默认引擎（peri）对待
    engineTypes: engineTypes ?? ["peri"],
    status: "online",
    metadata: { machineId },
  });
}

/**
 * 远程 machine 断连后，清理 transport 缓存并更新 node 状态为 offline。
 * 同时收敛该 machineId 下的所有实例记录，使后续 ensureRunning 能重新 launch。
 */
export function unregisterRemoteNode(machineId: string): void {
  remoteTransports.delete(machineId);
  const runtime = getCoreRuntime();
  const existing = runtime.getNode(machineId);
  if (existing) {
    runtime.updateNodeStatus(machineId, "offline");
  }
  // 该 machineId 下的实例必须连同实例登记表与空环境计数器一并收敛，否则沙盒销毁等
  // 不经过 ACP handler 的路径（Sandbox → Machine 释放 → 本函数）会永久占用并发额度。
  getBoundAgentRuntime().cleanupMachineInstances(machineId);
}
