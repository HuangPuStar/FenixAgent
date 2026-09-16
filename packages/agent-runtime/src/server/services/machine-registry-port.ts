/** ACP handler 所需的 Machine 注册与心跳能力，由宿主绑定。 */
export interface MachineRegistryPort {
  registerMachine(input: {
    agentName: string;
    tenantId: string | null;
    machineId: string;
  }): Promise<{ id: string; isNew: boolean }>;
  disconnectMachine(machineId: string, reason: string): Promise<void>;
  handleHeartbeat(machineId: string): Promise<void>;
  startHeartbeat(machineId: string, intervalMs: number, onTimeout: () => void): void;
  stopHeartbeat(machineId: string): void;
}

let machineRegistryPort: MachineRegistryPort | null = null;

/** 由 apps/server 绑定 Machine 资源包的唯一实现。 */
export function bindMachineRegistryPort(port: MachineRegistryPort): void {
  if (machineRegistryPort && machineRegistryPort !== port)
    throw new Error("MachineRegistryPort has already been bound");
  machineRegistryPort = port;
}

/** 获取已绑定端口；未装配时 fail-fast，禁止 runtime 回链到资源包。 */
export function getMachineRegistryPort(): MachineRegistryPort {
  if (!machineRegistryPort) throw new Error("MachineRegistryPort has not been bound");
  return machineRegistryPort;
}
