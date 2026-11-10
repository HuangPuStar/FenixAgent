import type { CoreRuntimeFacade } from "@fenix/core";
import type { RemoteTransport, WsConnectionLike } from "@fenix/remote-runtime";

/** Machine 注册时由 Core runtime 写入远端 transport 的最小连接槽位。 */
export type RemoteNodeTransportSlot = {
  remoteTransport?: RemoteTransport;
};

/** 远端节点注册模式。 */
export interface RegisterRemoteNodeOptions {
  /**
   * 同 server epoch 的传输重连：复用现有 transport 与 runtime 映射，只把连接切换给新 WS。
   * 缺省（clean-slate / 首次注册）仍按旧语义收敛该机器上的旧实例。
   */
  preserveRuntime?: boolean;
}

/**
 * 宿主提供的 Core runtime 能力。
 *
 * agent-runtime 不能自行构造 Core 单例；否则同一进程会出现两套实例注册与远端节点状态。
 */
export interface CoreRuntimePort {
  getCoreRuntime(): CoreRuntimeFacade;
  registerRemoteNode(
    machineId: string,
    ws: WsConnectionLike,
    entry: RemoteNodeTransportSlot,
    engineTypes?: string[],
    options?: RegisterRemoteNodeOptions,
  ): void;
  unregisterRemoteNode(machineId: string): void;
}

let coreRuntimePort: CoreRuntimePort | null = null;

/** 由 apps/server 在启动装配阶段绑定唯一的 Core runtime 实现。 */
export function bindCoreRuntimePort(port: CoreRuntimePort): void {
  if (coreRuntimePort && coreRuntimePort !== port) {
    throw new Error("CoreRuntimePort has already been bound");
  }
  coreRuntimePort = port;
}

/** 获取已绑定的宿主 Core runtime；未装配即失败，禁止隐式创建替代单例。 */
export function getBoundCoreRuntime(): CoreRuntimeFacade {
  if (!coreRuntimePort) throw new Error("CoreRuntimePort has not been bound");
  return coreRuntimePort.getCoreRuntime();
}

/** 获取已绑定的 Machine 注册能力。 */
export function getBoundCoreRuntimePort(): CoreRuntimePort {
  if (!coreRuntimePort) throw new Error("CoreRuntimePort has not been bound");
  return coreRuntimePort;
}

/** 测试用：清空宿主绑定，防止测试进程内状态泄漏。 */
export function resetCoreRuntimePortForTest(): void {
  coreRuntimePort = null;
}
