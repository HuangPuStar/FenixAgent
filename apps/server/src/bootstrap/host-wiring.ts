import { createAgentRuntimeModule } from "@fenix/agent-runtime/runtime";
import {
  bindAcpInstanceActivityPort,
  bindCoreRuntimePort,
  bindEnvironmentAcpLifecyclePort,
  bindFileWsPort,
  bindLocalNodeAgentNodeServicePort,
  bindMachineRegistryPort,
  bindSessionEventBusPort,
  environmentRepo,
  findMachineConnectionById,
  getAcpEventBus,
  getAgentNodeService,
  getAllEventBuses,
  removeEventBus,
  triggerMachineCleanupByMachineId,
} from "@fenix/agent-runtime/server";
import { createIdentityDirectory } from "@fenix/identity/server";
import { initializeApplicationInfrastructure, registerIdentityDirectory } from "@fenix/platform-sdk/server";
import { bindAcpEventBusPort } from "@fenix/resource-channel/server";
import {
  bindMachineEnvironmentPort,
  bindMachineHostPort,
  checkParsedObjectSize,
  checkWsMessageSize,
  disconnectMachine,
  estimateWsMessageBytes,
  findMachineAgentNamesByIds,
  formatFileWsCloseLog,
  handleFileWsClose,
  handleFileWsMessage,
  handleFileWsOpen,
  handleHeartbeat,
  LocalNodeAwareService,
  parseFileWsMessage,
  registerMachine,
  startHeartbeat,
  stopHeartbeat,
} from "@fenix/resource-machine/server";
import type { AppConfig } from "../config";
import { db } from "../db";
import type { ServerEnv } from "../env-loader";
import { getRedisConnection } from "../services/cache";
import { getCoreRuntime, registerRemoteNode, unregisterRemoteNode } from "../services/core-bootstrap";
import { buildModuleConfigs } from "./module-configs";
import { resolveWorkspacePathFromEnv } from "./workspace-path";

/**
 * 宿主运行态接线（启动序列的「装配期一次性接线」段）。
 *
 * 这一段没有异步步骤，也不碰 DB：它只做三件只有宿主进程能做、且必须早于任何模块工作的事——初始化平台
 * 基础设施、注册身份目录、把进程级运行态绑定到各包的端口。
 *
 * **时序不可调整**（理由随原注释保留）：
 * 1. 平台模块只能经 `@fenix/platform-sdk/server` 读基础设施，因此宿主必须在任何模块开始工作前完成唯一
 *    初始化；身份目录同样只允许注册一次——两个身份实现并存会让不同模块读到不一致的成员关系视图，而这类
 *    分歧不会在启动期暴露。
 * 2. `createAgentRuntimeModule().runtime` 是实例/环境生命周期与会话数据面的唯一入口，宿主在此绑定一次，
 *    路由与消费包随后经 `getBoundAgentRuntime()` 取用（同时由该模块的 create 绑定包内编排 seam，§4.6：
 *    `AgentInstanceRuntimeOperations` 是包内装配细节，宿主不再把包导出的函数转发回去）。
 * 3. 10 个 `bind*Port` 把「宿主进程级单例」交给包：machine 的 workspace 根与 Core runtime 节点查询、
 *    agent-runtime 的 environment 原语与事件总线、file-ws 治理函数、ACP 环境生命周期。包不反向导入宿主
 *    取值，未绑定时包内调用即失败，不隐式回退。
 *
 * 「启动前取数」的两个端口（`bindAgentLaunchSpecPort` / `bindAgentConfigLookupPort`）**不在本文件**：它们的
 * 目标实现产自 agent-config 的启动参数组装器，必须在 `wirePermissions` 装配完成、且模型网关凭证解析器就绪
 * 之后才绑定，由 `host-startup.ts` 承担。
 */
export type AgentRuntimeHandles = ReturnType<typeof createAgentRuntimeModule>["runtime"];

/** 接线结果：后续启动序与关闭序都要用的宿主句柄。 */
export interface HostWiring {
  readonly agentRuntime: AgentRuntimeHandles;
}

/** 初始化平台基础设施、注册身份目录并绑定全部宿主运行态端口。 */
export function wireHostRuntime(env: ServerEnv, appConfig: AppConfig): HostWiring {
  initializeApplicationInfrastructure({
    database: db,
    // Redis 同样是进程能力：宿主是唯一建连点，包经 `getRedisConnection()` 取用（未配置 `RCS_REDIS_URL` 时
    // 返回 null，调用方跳过快照持久化）。这里传 provider 而不是连接本身——`services/cache` 首次 `getCache()`
    // 才建连，装配期取值会把「尚未建连」固化成永久 null。
    redisConnection: () => getRedisConnection(),
    moduleConfigs: buildModuleConfigs(env, appConfig),
  });
  registerIdentityDirectory(createIdentityDirectory());

  const agentRuntime = createAgentRuntimeModule().runtime;
  bindCoreRuntimePort({ getCoreRuntime, registerRemoteNode, unregisterRemoteNode });
  bindMachineRegistryPort({
    registerMachine,
    disconnectMachine,
    handleHeartbeat,
    startHeartbeat,
    stopHeartbeat,
    // 只读投影：runtime 不得回链资源包，取数走这里绑定的实现（§1.7 B1，表已归 machine）。
    findMachineAgentNamesByIds,
  });
  // Machine 包的宿主运行态：workspace 根、Core runtime 节点、file-ws 连接索引与断连清理都是宿主进程级单例，
  // 包不反向导入 agent-runtime 取值，改由这里一次绑定（未装配时包内调用即失败，不隐式回退）。
  bindMachineHostPort({
    // workspace 根归宿主解析（`./workspace-path`）：机器侧要求每次调用直读 `WORKSPACE_ROOT`，与 agent-runtime
    // 包内读配置快照的 `resolveWorkspacePath` 是两种语义，1.7 C1 起分开（见该文件的说明）。
    resolveWorkspacePath: resolveWorkspacePathFromEnv,
    // Core runtime 单例归宿主（`./services/core-bootstrap`），此处只暴露「按 machineId 查节点」的窄视图。
    getCoreRuntimeNode: (machineId) => getCoreRuntime().getNode(machineId),
    unregisterCoreRuntimeNode: unregisterRemoteNode,
    findMachineConnectionById,
    triggerMachineCleanupByMachineId,
  });
  // Machine 包读 environment 的两个原语（记录读取 + 归属校验）：实现仍在 agent-runtime，由此处转发。
  bindMachineEnvironmentPort({
    getEnvironmentById: (environmentId) => environmentRepo.getById(environmentId),
    getOwnedEnvironment: agentRuntime.getOwnedEnvironment,
  });
  bindSessionEventBusPort({
    getAllBuses: () => getAllEventBuses(),
    removeBus: (sessionId) => removeEventBus(sessionId),
  });
  bindLocalNodeAgentNodeServicePort({
    getAgentNodeService: () => new LocalNodeAwareService(getAgentNodeService),
  });
  bindAcpEventBusPort({ getAcpBus: (agentId) => getAcpEventBus(agentId) });
  bindFileWsPort({
    checkParsedObjectSize,
    checkWsMessageSize,
    estimateWsMessageBytes,
    formatFileWsCloseLog,
    handleFileWsClose,
    handleFileWsMessage,
    handleFileWsOpen,
    parseFileWsMessage,
  });
  bindEnvironmentAcpLifecyclePort({
    closeAcpConnections: agentRuntime.closeAcpConnectionsForEnvironments,
    stopInstances: agentRuntime.stopInstancesForEnvironments,
  });
  bindAcpInstanceActivityPort(agentRuntime.touchInstanceActivity);

  return { agentRuntime };
}
