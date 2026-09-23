/** Relay 生命周期回调由 Chat 装配层绑定，避免 transport 反向依赖服务层。 */
export interface RelayLifecyclePort {
  closeClientsByInstance(instanceId: string, code: number, reason: string): void;
  reclaimInstanceRealtimeResources(instanceId: string): Promise<void>;
  closeAllClients(code: number, reason: string): void;
}

let relayLifecyclePort: RelayLifecyclePort | null = null;

/** 绑定 Relay 对 Chat 实时资源的生命周期操作；未绑定时明确拒绝执行。 */
export function bindRelayLifecyclePort(port: RelayLifecyclePort): void {
  relayLifecyclePort = port;
}

/** 测试后解绑 Relay 生命周期回调，防止进程内模块状态泄漏。 */
export function resetRelayLifecyclePort(): void {
  relayLifecyclePort = null;
}

/**
 * 读取当前绑定，未绑定时返回 `null`（与 `getRelayLifecyclePort` 不同，不做 fail-fast）。
 *
 * 供测试替身「保存—还原」使用：默认绑定是 `chat-channel-bootstrap` 的**模块级副作用**，测试里一次
 * `resetRelayLifecyclePort()` 会把绑定置空，而同进程后续测试文件再 import 该装配模块只会命中模块缓存、
 * 不会重新绑定（实测：`acp-idle-monitor` 的回收用例会因 `closeRelayConnectionsForIdleReclaim` 抛
 * 「port is not bound」被 sweep 吞掉，表现为实例静默不回收）。因此替换绑定的用例必须还原前一次绑定，
 * 不能留下 `null`。
 */
export function tryGetRelayLifecyclePort(): RelayLifecyclePort | null {
  return relayLifecyclePort;
}

function getRelayLifecyclePort(): RelayLifecyclePort {
  if (!relayLifecyclePort) throw new Error("Relay lifecycle port is not bound");
  return relayLifecyclePort;
}

export function closeRelayConnectionsForIdleReclaim(instanceId: string): void {
  getRelayLifecyclePort().closeClientsByInstance(instanceId, 4001, "instance_idle_reclaimed");
}

export function closeRelayConnectionsForStoppedInstance(instanceId: string): void {
  getRelayLifecyclePort().closeClientsByInstance(instanceId, 4002, "instance_stopped");
}

export function reclaimInstanceYjsDocs(instanceId: string): Promise<void> {
  return getRelayLifecyclePort().reclaimInstanceRealtimeResources(instanceId);
}

export function closeAllRelayConnections(): void {
  getRelayLifecyclePort().closeAllClients(1001, "server_shutdown");
}

export function closeRelayClientsForMachine(instanceId: string, reason: string): void {
  getRelayLifecyclePort().closeClientsByInstance(instanceId, 4500, reason);
}
