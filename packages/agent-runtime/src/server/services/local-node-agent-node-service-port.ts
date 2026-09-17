import type { AgentNodeServicePort } from "@fenix/orchestration";

/** 编排控制器所需的本地节点感知服务，由 apps/server 绑定。 */
export interface LocalNodeAgentNodeServicePort {
  getAgentNodeService(): AgentNodeServicePort;
}

let localNodeAgentNodeServicePort: LocalNodeAgentNodeServicePort | null = null;

/** 绑定 Machine 提供的 local-default 节点服务。 */
export function bindLocalNodeAgentNodeServicePort(port: LocalNodeAgentNodeServicePort): void {
  localNodeAgentNodeServicePort = port;
}

/** 获取宿主装配的节点服务，禁止 runtime 反向导入 Machine 包。 */
export function getLocalNodeAgentNodeService(): AgentNodeServicePort {
  if (!localNodeAgentNodeServicePort) throw new Error("Local node AgentNodeService port has not been bound");
  return localNodeAgentNodeServicePort.getAgentNodeService();
}

/** 测试后解除绑定，防止后续用例复用错误的节点服务。 */
export function resetLocalNodeAgentNodeServicePort(): void {
  localNodeAgentNodeServicePort = null;
}
