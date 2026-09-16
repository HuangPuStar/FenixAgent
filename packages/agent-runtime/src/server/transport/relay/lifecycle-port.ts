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
