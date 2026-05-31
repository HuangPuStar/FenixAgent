import { type CoreRuntimeFacade, createCoreRuntime } from "@fenix/core";
import { createEnginePlugin, type OpencodeRuntime } from "@fenix/opencode";
import {
  createRemoteRuntime,
  createWsRemoteTransport,
  type RemoteTransport,
  type WsConnectionLike,
} from "@fenix/remote-runtime";
import type { WsConnection } from "../transport/ws-types";

let facade: CoreRuntimeFacade | null = null;

// 缓存远程 transport 实例
const remoteTransports = new Map<string, RemoteTransport>();

function defaultCreateFacade(): CoreRuntimeFacade {
  return createCoreRuntime({
    plugins: [createEnginePlugin()],
    nodes: [
      {
        id: "local-default",
        mode: "local",
        engineTypes: ["opencode"],
        status: "online",
      },
    ],
    onInstanceStarted(instanceId, runtime, updateMetadata) {
      const opencode = runtime as OpencodeRuntime;
      const state = opencode.getInstanceState(instanceId);
      if (state) {
        updateMetadata({
          port: state.port ?? 0,
          token: state.token ?? "",
        });
      }
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
 */
export function registerRemoteNode(machineId: string, ws: WsConnection): void {
  const runtime = getCoreRuntime();

  // Bun WS 实际支持 onmessage，但 WsConnection 接口未声明；运行时安全断言
  const wsLike = ws as unknown as WsConnectionLike;
  const transport = createWsRemoteTransport(wsLike);
  remoteTransports.set(machineId, transport);

  const existing = runtime.getNode(machineId);
  if (existing) return;

  runtime.registerNode({
    id: machineId,
    mode: "remote",
    engineTypes: ["opencode"],
    status: "online",
    metadata: { machineId },
  });
}

/**
 * 远程 machine 断连后，清理 transport 缓存。
 */
export function unregisterRemoteNode(machineId: string): void {
  remoteTransports.delete(machineId);
}
