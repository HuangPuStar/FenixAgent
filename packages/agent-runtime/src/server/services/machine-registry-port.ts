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
  /**
   * 按 machine id 批量取 **agent 名**投影（environment 的 `machineName` 用它）；空入参返回空 Map。
   *
   * 只读投影与上面的生命周期方法同一个理由：runtime **不得**回链资源包。这里早年经宿主
   * `@server/db/schema` 直接读 `machine` 表，表随 §1.7 B1 归 `@fenix/resource-machine` 后，直读表对象
   * 既违反 §6.1 的路径作用域（调用期只能经包根入口的 service / DTO 取数），也会因为 agent-config 与
   * machine 互相依赖而在模块装配期成环——所以取数走宿主在这个端口上绑定的实现。
   */
  findMachineAgentNamesByIds(ids: readonly string[]): Promise<ReadonlyMap<string, string>>;
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

/**
 * 测试用：清空宿主绑定，使用例可以重新绑定替身端口。
 *
 * 与 `core-runtime-port` 的 `resetCoreRuntimePortForTest` 同口径——`bindMachineRegistryPort` 对「已绑定
 * 另一个 port」抛错，而宿主 preload 在进程启动时就绑好了转发端口，没有这个入口包内用例无法改绑。
 * 复位方（`@fenix/agent-runtime/server/testing` 的 `resetMachineRegistryPortStub`）负责把宿主端口绑回去。
 */
export function resetMachineRegistryPortForTest(): void {
  machineRegistryPort = null;
}
