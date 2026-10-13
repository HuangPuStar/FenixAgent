// host-port.ts — 本包对宿主运行态能力的绑定入口
//
// 为什么需要这一层：Machine 包依赖三类只存在于宿主运行时的能力——
//   1. workspace 根路径：`WORKSPACE_ROOT` 是跨包共享的进程级配置，读取归宿主与平台契约
//      （`@fenix/platform-sdk/testing` 的 workspace 根锁即建立在这一前提上：只有本包参与互斥
//      等于没有锁，别的包的文件照旧改根）。1.7 C1 起宿主直接绑定自己的解析实现
//      （`apps/server/src/bootstrap/workspace-path.ts`），不再经 agent-runtime 转发——那条路径读的是
//      启动期配置快照，会让「每次调用直读 env」的根锁失效；
//   2. Core runtime 的远端节点注册表：单例由宿主装配，包内自行构造会出现两套节点状态；
//   3. file-ws 连接索引与断连清理：索引的 owner 在 agent-runtime 的 acp-ws 侧，本包只消费。
//
// 三者都不是 Machine 的领域。此前经 `@fenix/agent-runtime/server` 取值（台账 `special-dependency`
// 与 `no-circular`，owner 1.4），改为宿主编译期绑定后该反向边消除。
//
// 绑定语义与 `@fenix/agent-runtime` 的 `bindCoreRuntimePort` 一致：装配阶段一次绑定，重复绑定视为
// 装配错误；未绑定即失败，**不隐式回退到本地实现**——回退会让宿主持有的运行态与包内看到的裂成两份，
// 正是本文件要消除的那类问题。
//
// 测试替换与宿主绑定是两层（与 `environment-port.ts` 同构）：`bindMachineHostPort` 是**装配**入口
// （一次绑定，重复绑定报错），`setMachineHostPort` 是**用例**替换入口（浅合并，可重复调用）。叠加时
// 替换值优先，用例因此可以只打桩 `getCoreRuntimeNode`，其余四个原语继续走宿主实现。

/**
 * Core runtime 远端节点的最小句柄。
 *
 * `file-machine-events` 只用它的**存在性**做 register 对账（node 存在即表示该机器完成过 acp-ws 注册），
 * 不读任何字段。因此这里不引入 `@fenix/core` 的类型，避免把 core 的领域模型钉进本包契约——
 * 与 `MachineEnvironmentRecord` 只声明四个字段是同一条理由。
 */
export type MachineRuntimeNodeHandle = object;

/** Machine 包的宿主运行态契约。 */
export interface MachineHostPort {
  /**
   * 计算环境隔离的 workspace 根路径 `{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}`。
   *
   * 实现必须**每次调用直读** `process.env.WORKSPACE_ROOT`（宿主绑的是
   * `apps/server/src/bootstrap/workspace-path.ts`，1.7 C1 起不再复用 agent-runtime 的同名函数）：fs 用例
   * 经 workspace 根锁按用例把根切到 `mkdtemp` 目录，读启动期配置快照会让锁静默失效。
   */
  resolveWorkspacePath(organizationId: string, userId: string, environmentId: string): string;

  /** Core runtime 中该机器的远端节点；未注册返回 null。 */
  getCoreRuntimeNode(machineId: string): MachineRuntimeNodeHandle | null;

  /** 注销该机器的远端运行时路由（机器退役、释放沙盒时调用）。 */
  unregisterCoreRuntimeNode(machineId: string): void;

  /** file-ws 连接索引中该机器的活跃连接；无连接返回 null。 */
  findMachineConnectionById(machineId: string): object | null;

  /** 触发该机器维度的 relay 清理（sweep 检出的断连无法关联具体 wsId，故按 machineId 清理）。 */
  triggerMachineCleanupByMachineId(machineId: string, reason: string): void;
}

let hostPort: MachineHostPort | null = null;
/** 用例替换值（浅合并，优先于宿主绑定）。 */
let override: Partial<MachineHostPort> | null = null;

/** 由 `apps/server` 在启动装配阶段绑定唯一的宿主运行态实现。 */
export function bindMachineHostPort(port: MachineHostPort): void {
  if (hostPort && hostPort !== port) {
    throw new Error("MachineHostPort has already been bound");
  }
  hostPort = port;
}

/**
 * 替换宿主运行态实现（用例装配用）。
 *
 * 浅合并语义：只传需要替换的原语；传 `null` 恢复为宿主绑定实现。复位统一走
 * `@fenix/resource-machine/server/testing` 登记的 `registerStubResetter`，避免用例之间状态泄漏。
 */
export function setMachineHostPort(overrides: Partial<MachineHostPort> | null): void {
  override = overrides ? { ...override, ...overrides } : null;
}

/**
 * 获取当前生效的宿主运行态（用例替换值优先，否则为宿主绑定实现）。
 *
 * 未装配即失败，禁止隐式创建替代实现：宿主持有的 Core runtime 节点表与 file-ws 连接索引是进程级单例，
 * 包内自行构造第二个等于把同一台机器的运行态裂成两份。
 */
export function getMachineHostPort(): MachineHostPort {
  const resolveWorkspacePath = override?.resolveWorkspacePath ?? hostPort?.resolveWorkspacePath;
  const getCoreRuntimeNode = override?.getCoreRuntimeNode ?? hostPort?.getCoreRuntimeNode;
  const unregisterCoreRuntimeNode = override?.unregisterCoreRuntimeNode ?? hostPort?.unregisterCoreRuntimeNode;
  const findMachineConnectionById = override?.findMachineConnectionById ?? hostPort?.findMachineConnectionById;
  const triggerMachineCleanupByMachineId =
    override?.triggerMachineCleanupByMachineId ?? hostPort?.triggerMachineCleanupByMachineId;
  if (
    !resolveWorkspacePath ||
    !getCoreRuntimeNode ||
    !unregisterCoreRuntimeNode ||
    !findMachineConnectionById ||
    !triggerMachineCleanupByMachineId
  ) {
    throw new Error("MachineHostPort has not been bound");
  }
  return {
    resolveWorkspacePath,
    getCoreRuntimeNode,
    unregisterCoreRuntimeNode,
    findMachineConnectionById,
    triggerMachineCleanupByMachineId,
  };
}

/** 测试用：清空宿主绑定，让下个用例从干净状态重新绑定（用例复位走 `setMachineHostPort(null)`）。 */
export function resetMachineHostPortForTest(): void {
  hostPort = null;
}
