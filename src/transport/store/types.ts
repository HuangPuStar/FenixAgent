/** TransportStore 抽象接口，统一单节点（内存 Map）和多节点（Redis）的状态存储操作。 */
export interface TransportStore {
  setRelaySocket(instanceId: string, socketId: string): Promise<void>;
  getRelaySocket(instanceId: string): Promise<string | null>;
  delRelaySocket(instanceId: string): Promise<void>;
  setMachineSocket(machineId: string, socketId: string): Promise<void>;
  getMachineSocket(machineId: string): Promise<string | null>;
  delMachineSocket(machineId: string): Promise<void>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;
  healthCheck(): Promise<boolean>;
  close(): Promise<void>;
}
