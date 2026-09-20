/**
 * Agent Runtime 的对外运行入口（CE 阶段 2 任务 1.4 / W3）。
 *
 * 与 `./server` 的方向相反：`./server` 是**宿主装配面**（宿主向本包注入运行基础能力：
 * `bind*Port`、路由工厂注入、模块配置），本文件是**本包向外的运行能力面**（其它包与宿主
 * 业务路由消费实例/环境的启动、停止、状态、回收，以及会话与 relay 数据面原语）。
 *
 * 两条契约面：
 * - `AgentRuntimePort`：管理面。回答「实例/环境在不在、怎么起、怎么停、怎么回收」。
 * - `AgentRuntimeSessionApi`：数据面。回答「怎么跑一轮」——relay 连接、ACP session/turn、
 *   定向投递。数据面原语是 ACP 协议适配层的直接能力，不是业务语义（不解释 actor/role）。
 *
 * 设计约束（1.4 裁定）：
 * - 输入只接受已授权的通用参数；Runtime 不查 actor/role/visibility。「启动前取数」（取
 *   agentConfig、组装 LaunchSpec）由 W4 搬到 AgentConfig Facade，经 `AgentInstanceStarter`
 *   由宿主注入，**不在本 port 的输入里**——`ensureInstance` 的输入是「哪个环境的哪个属主要
 *   哪种实例」，不是「拿什么参数起进程」。
 * - 本文件不新增行为：每个方法都是既有包内实现的显式转发。返回类型暂时用 `Awaited<ReturnType<...>>`
 *   派生自实现（`listEnvironmentsWithInstances` 一类含 DB join 投影的函数尚无显式返回类型），
 *   移除条件：W6 收敛消息面时把这些派生类型替换为显式契约类型。
 * - 实例记录级操作（`getOwnedInstance` / `createInstance` / `stopInstanceRuntime` / …）**直通
 *   `AgentInstanceRecord`**（1.4 W3b 裁定）：控制台要回显实例名/environmentId、编排层要拿记录去
 *   取租约，把记录改成面内的窄视图只会造出第二份投影并在两侧漂移。代价是持久化记录类型出现在
 *   契约面上，与上面那条派生返回类型一并记入 W6 收敛清单。
 * - 尚未收口的能力（`environmentRepo`、`agentInstanceRepo`、event bus、`listAcpConnections`、
 *   `listExternalRelayEntries`、`resolveWorkspacePath`、`EnvironmentRecord` 等内部状态访问）不
 *   属于本 port，仍留在 `./server` 并标注 W6；它们不进 port 是因为其消费方（observer、workflow
 *   的部分路径）需要的是内部投影，收敛方式待 W6 按消费方逐包裁定。
 */

import type { AgentInstanceRecord } from "./server/repositories/agent-instance";
import type { RuntimeSnapshot, RuntimeStopMode } from "./server/services/agent-instance-runtime-coordinator";
import type { SpawnedInstance } from "./server/services/agent-instance-runtime-projection";
import {
  findRunningInstanceByEnvironment,
  getInstance,
  listInstances as listRuntimeInstances,
  stopInstance,
} from "./server/services/agent-instance-runtime-projection";
import type { AutomaticInstanceSelection } from "./server/services/agent-instance-service";
import { agentInstanceService, bindAgentInstanceRuntimeOperations } from "./server/services/agent-instance-service";
import {
  createWebEnvironment,
  listEnvironmentsWithInstances,
  updateWebEnvironment,
} from "./server/services/environment-web";
import {
  closeAcpConnectionsForEnvironments,
  closeAllAcpConnections,
  sendToAgentWs,
} from "./server/transport/acp-ws-handler";
import { connectAgentRelay } from "./server/transport/agent-relay";
import { closeAllRelayConnections } from "./server/transport/relay";
import { sendToInstanceRelay } from "./server/transport/relay/relay-handler";
import {
  listInstanceActivitySnapshotsWithUsers,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  startAcpIdleMonitor,
  stopAcpIdleMonitor,
  touchInstanceActivity,
} from "./services/acp-idle-monitor";
import type { AgentSession, PromptTurn, PromptTurnStartOptions } from "./services/agent-chat-service";
import { createAgentSession, createPromptTurn, openAgentSession, startPromptTurn } from "./services/agent-chat-service";
import { getEnvironmentBySecret } from "./services/environment-acp";
import type { EnvironmentRole } from "./services/environment-core";
import { deleteEnvironment, getOwnedEnvironment } from "./services/environment-core";
import { globalInstanceRegistry } from "./services/instance-registry";
import { getOrchestrationController } from "./services/orchestration-bootstrap";
import type { StopInstancesForEnvironmentsOptions } from "./services/orchestration-instance";
import {
  refreshInstanceEnvironment,
  spawnInstanceViaController,
  stopInstancesForEnvironments,
  stopInstanceViaController,
  terminateLocalDeadInstance,
} from "./services/orchestration-instance";
import { cleanupOrchestrationInstancesForMachine } from "./services/orchestration-machine-cleanup";
import { getSession, resolveExistingSessionId, updateSessionStatus } from "./services/session";

// ─────────────────────────────────────────────────────────────────────────────
// 派生自实现的返回类型（W6 收敛为显式契约类型，见文件头「设计约束」）
// ─────────────────────────────────────────────────────────────────────────────

type CreateEnvironmentResult = Awaited<ReturnType<typeof createWebEnvironment>>;
type UpdateEnvironmentResult = Awaited<ReturnType<typeof updateWebEnvironment>>;
type ListEnvironmentsResult = Awaited<ReturnType<typeof listEnvironmentsWithInstances>>;
type OwnedEnvironmentResult = Awaited<ReturnType<typeof getOwnedEnvironment>>;
type EnvironmentBySecretResult = Awaited<ReturnType<typeof getEnvironmentBySecret>>;
type InstanceActivityList = Awaited<ReturnType<typeof listInstanceActivitySnapshotsWithUsers>>;
type RelayHandle = Awaited<ReturnType<typeof connectAgentRelay>>;
type StopInstanceResult = Awaited<ReturnType<typeof stopInstance>>;
type PromptTurnStartResult = Awaited<ReturnType<typeof startPromptTurn>>;

/** `ensureInstance` 的输入：已授权的实例归属与选择方式（见文件头：不含启动参数）。 */
export interface EnsureInstanceInput {
  readonly environmentId: string;
  /** 实例属主；必须与环境属主一致，由调用方保证（Runtime 不解释 actor）。 */
  readonly ownerUserId: string;
  /** 指定实例时必须属于该属主且属于该环境，否则按未找到处理。 */
  readonly requestedInstanceUid?: string;
  /** 未指定实例时的自动选择类别（chat / api / workflow 各自的持久实例）。 */
  readonly automaticSelection: AutomaticInstanceSelection;
  /** 取消信号：启动过程中断时不再继续（实例记录已存在时保持既有语义）。 */
  readonly signal?: AbortSignal;
}

/** `createInstance` 的输入：新建一个非默认的持久实例（不启动 runtime，启动走 `ensureInstanceRuntime`）。 */
export interface CreateInstanceInput {
  readonly environmentId: string;
  /** 实例属主；必须与环境属主一致，由调用方保证（Runtime 不解释 actor）。 */
  readonly ownerUserId: string;
  /** 记录创建者（审计列）；交互式控制台里与属主相同。 */
  readonly actorUserId: string;
  /** 实例名，须唯一可读；空串、超过 100 字符或保留名 `default` 会被实现拒绝（400）。 */
  readonly name: string;
}

/**
 * 管理面：实例与环境的生命周期。
 *
 * 四组语义：启动（实例/环境的创建与运行保证）、停止、状态（查询与活跃度标记）、回收
 * （空闲清理、机器下线清理、进程退出）。
 */
export interface AgentRuntimePort {
  // ── 启动 ──

  /** 确保指定环境下属主的实例存在且已启动，返回该实例记录（`resolveInstanceForOperation` + `ensureInstanceRuntime`）。 */
  ensureInstance(input: EnsureInstanceInput): Promise<AgentInstanceRecord>;
  /** 启动一个已存在的实例记录（幂等：目标状态已达成时直接返回）。 */
  ensureInstanceRuntime(instance: AgentInstanceRecord, signal?: AbortSignal): Promise<void>;
  /** 查找或创建环境的下属主默认实例（`chat` 类，名 `default`），不启动 runtime。 */
  findOrCreateDefaultInstance(environmentId: string, ownerUserId: string): Promise<AgentInstanceRecord>;
  /**
   * 查找或创建环境的下属主 workflow 持久实例（名 `primary`），并回报本次是否新建。
   *
   * `created` 是编排层的所有权判据：只有自己创建的实例才由自己负责停止，复用别人已启动的实例
   * 不能顺手停掉（见 workflow 的实例清理路径）。
   */
  findOrCreateWorkflowInstanceWithStatus(
    environmentId: string,
    ownerUserId: string,
  ): Promise<{ instance: AgentInstanceRecord; created: boolean }>;
  /** 新建持久实例记录（`creationSource: "user"`）；不做环境归属校验，调用方先查环境。 */
  createInstance(input: CreateInstanceInput): Promise<AgentInstanceRecord>;
  /** 创建 Web 环境（含默认实例的启动编排）。 */
  createEnvironment(params: Parameters<typeof createWebEnvironment>[0]): Promise<CreateEnvironmentResult>;
  /** 更新环境配置；是否重启实例由实现按需决定。 */
  updateEnvironment(
    environmentId: string,
    organizationId: string,
    params: Parameters<typeof updateWebEnvironment>[2],
  ): Promise<UpdateEnvironmentResult>;
  /** 重启指定环境下处于运行/启动中的实例，返回被重启的实例 ID。 */
  restartActiveInstancesForEnvironments(environmentIds: string[]): Promise<string[]>;
  /** 打开一次程序化 Agent 会话（`api/primary` 类持久实例 + 独立 relay/ACP session）。 */
  openAgentSession(
    input: Parameters<typeof openAgentSession>[0],
  ): Promise<Awaited<ReturnType<typeof openAgentSession>>>;

  // ── 停止 ──

  /** 停止单个实例（含组织归属校验；幂等，目标状态已达成时返回成功）。 */
  stopInstance(instanceUid: string, organizationId: string): Promise<StopInstanceResult>;
  /** 停止实例 runtime，保留实例记录（`mode: "strict"` 下停止失败即抛错）。 */
  stopInstanceRuntime(instance: AgentInstanceRecord, mode?: RuntimeStopMode): Promise<void>;
  /** 用同一实例 uid 重启 runtime（记录不变；默认实例同样支持）。 */
  restartInstanceRuntime(instance: AgentInstanceRecord): Promise<void>;
  /** 停止 runtime 并删除实例记录；默认实例被拒（`DEFAULT_INSTANCE_DELETE_DENIED` 409）。 */
  deleteInstance(instance: AgentInstanceRecord): Promise<void>;
  /** 停止指定环境下的全部实例，返回被停止的实例 ID。 */
  stopInstancesForEnvironments(
    environmentIds: string[],
    options?: StopInstancesForEnvironmentsOptions,
  ): Promise<string[]>;
  /** 删除环境。 */
  deleteEnvironment(environmentId: string): Promise<boolean>;
  /** 关闭指定环境的 ACP 连接（relay 连接另行关闭）。 */
  closeAcpConnectionsForEnvironments(environmentIds: string[]): void;
  /** 关闭全部 ACP 连接（进程退出路径）。 */
  closeAllAcpConnections(): void;
  /** 关闭全部前端 relay/YJS 连接（进程退出路径）。 */
  closeAllRelayConnections(): void;

  // ── 状态 ──

  /** 读环境并做归属校验（组织 + 可选用户/角色）；不满足时按权限语义抛错。 */
  getOwnedEnvironment(
    environmentId: string,
    organizationId: string,
    userId?: string,
    role?: EnvironmentRole,
  ): Promise<OwnedEnvironmentResult>;
  /** 列出组织下环境及其实例计数/agent 名（控制台列表）。 */
  listEnvironments(organizationId: string, viewerUserId?: string): Promise<ListEnvironmentsResult>;
  /** 按 Environment Secret 查环境（机器/节点上报路径）。 */
  getEnvironmentBySecret(secret: string): Promise<EnvironmentBySecretResult>;
  /** 按环境找运行中的实例（多实例场景返回其一）。 */
  findRunningInstanceByEnvironment(environmentId: string, userId?: string): SpawnedInstance | undefined;
  /** 按组织列出内存运行态实例。 */
  listRuntimeInstances(organizationId: string): SpawnedInstance[];
  /** 按实例 ID 读内存运行态实例（带可选归属校验）。 */
  getRuntimeInstance(instanceUid: string, userId?: string): SpawnedInstance | undefined;
  /** 按属主读单个持久实例记录；不属于该属主（或 uid 非法）按未找到处理。 */
  getOwnedInstance(instanceUid: string, ownerUserId: string): Promise<AgentInstanceRecord>;
  /** 按属主列出持久实例记录及其运行态快照。 */
  listOwnedInstances(
    ownerUserId: string,
    environmentId?: string,
  ): Promise<Array<AgentInstanceRecord & { runtime: RuntimeSnapshot }>>;
  /** 读持久实例的运行态快照（状态机 + generation + 最近失败）。 */
  getRuntimeSnapshot(instanceUid: string): RuntimeSnapshot;
  /** 列出实例活跃度投影（含用户、spawn 来源、idle/activity 判定），供控制台与回收巡检使用。 */
  listInstanceActivity(now?: number, organizationId?: string, showError?: boolean): Promise<InstanceActivityList>;
  /** 记录一次 ACP 业务消息带来的活跃度时间戳。 */
  touchInstanceActivity(instanceId: string, message: Record<string, unknown>, at?: number): void;
  /** 标记前端 relay 已挂到实例（引用计数）。 */
  markInstanceRelayAttached(instanceId: string, at?: number): void;
  /** 标记前端 relay 已从实例断开。 */
  markInstanceRelayDetached(instanceId: string, at?: number): void;
  /** 刷新实例的 workspace 配置与 Skills（复用运行实例新建 ACP session 前调用）。 */
  refreshInstanceEnvironment(instanceId: string, environmentId: string, userId: string): Promise<void>;
  /** 读 RCS 会话记录。 */
  getSession(sessionId: string): Promise<Awaited<ReturnType<typeof getSession>>>;
  /** 从 ACP session ID 反解已存在的 RCS 会话 ID。 */
  resolveExistingSessionId(sessionId: string): Promise<string | null>;
  /** 更新会话状态（active / archived 等）。 */
  updateSessionStatus(sessionId: string, status: string): void;

  // ── 回收 ──

  /** 机器下线时清理其上的编排实例，返回清理数量。 */
  cleanupInstancesForMachine(machineId: string): number;
  /**
   * 从实例登记表移除一个实例，并清掉它的并发计数。
   *
   * 宿主把实例从 Core runtime 删除时必须配对调用：登记表留着条目会继续计入并发额度，
   * 且 `hasActiveInstance` 会误判为存活，实例再也回收不掉。
   */
  unregisterInstance(instanceUid: string): void;
  /** 回收确认已死亡的本地实例（异步；不阻塞调用方消息循环）。 */
  terminateLocalDeadInstance(instanceId: string): Promise<void>;
  /** 启动 ACP 空闲回收巡检。 */
  startIdleMonitor(): void;
  /** 停止 ACP 空闲回收巡检。 */
  stopIdleMonitor(): void;
  /** 进程退出：停止全部实例 runtime 并释放编排资源。 */
  shutdown(): Promise<void>;
}

/**
 * 数据面：会话与 relay 原语。
 *
 * 这些是 ACP 协议适配层的直接能力，业务编排（三条链路）各自组合它们；port 不替调用方
 * 做 session/turn 生命周期决策（`release` vs `dispose` 的语义差异见各实现注释）。
 */
export interface AgentRuntimeSessionApi {
  /** 建立到实例的 relay 连接（共享 relay handle；同一 instanceId 的调用方共享连接）。 */
  connectRelay(instanceId: string, sessionId: string): Promise<RelayHandle>;
  /** 由 relay handle 构造 AgentSession（`dispose` 会关闭 relay handle）。 */
  createAgentSession(config: Parameters<typeof createAgentSession>[0]): AgentSession;
  /** 构造 PromptTurn（同一 ACP session 可多轮）。 */
  createPromptTurn(session: AgentSession, sessionId: string): PromptTurn;
  /** 新建或恢复 ACP session 并开始一轮 prompt。 */
  startPromptTurn(options: PromptTurnStartOptions): Promise<PromptTurnStartResult>;
  /** 向实例所在机器的 ACP 连接定向投递消息。 */
  sendToAgentWs(agentId: string, message: object): boolean;
  /** 向实例的 remote relay 定向投递消息。 */
  sendToInstanceRelay(instanceId: string, data: string): boolean;
}

/** 本包的对外运行入口：管理面在顶层，数据面在 `session`。 */
export interface AgentRuntime extends AgentRuntimePort {
  readonly session: AgentRuntimeSessionApi;
}

/**
 * Runtime 模块的运行时表面（`fenix.module.ts` 的 `create` 目标）。
 *
 * 只暴露需要「对象身份」的能力：实例与环境的生命周期是本包唯一持有进程级可变状态的职责面，
 * 再构造一套等于给同一批实例开两条回收路径。因此组合根返回包内既有单例的入口。
 */
export interface AgentRuntimeModule {
  readonly id: "agent-runtime";
  readonly runtime: AgentRuntime;
}

/**
 * 构造运行入口。
 *
 * 每次调用返回新的对象，但内部持有的都是本包的模块级单例（`agentInstanceService`、
 * `globalInstanceRegistry`、relay 连接表），因此多次构造不会产生第二套运行状态——与
 * `AgentInstanceRuntimeCoordinator` 的装配语义一致。
 */
export function createAgentRuntime(): AgentRuntime {
  const port: AgentRuntimePort = {
    async ensureInstance(input) {
      const instance = await agentInstanceService.resolveInstanceForOperation({
        environmentId: input.environmentId,
        ownerUserId: input.ownerUserId,
        requestedInstanceUid: input.requestedInstanceUid,
        automaticSelection: input.automaticSelection,
      });
      await agentInstanceService.ensureInstanceRuntime(instance, input.signal);
      return instance;
    },
    ensureInstanceRuntime: (instance, signal) => agentInstanceService.ensureInstanceRuntime(instance, signal),
    findOrCreateDefaultInstance: (environmentId, ownerUserId) =>
      agentInstanceService.findOrCreateDefaultInstance(environmentId, ownerUserId),
    findOrCreateWorkflowInstanceWithStatus: (environmentId, ownerUserId) =>
      agentInstanceService.findOrCreateWorkflowInstanceWithStatus(environmentId, ownerUserId),
    createInstance: (input) => agentInstanceService.createUserInstance(input),
    createEnvironment: (params) => createWebEnvironment(params),
    updateEnvironment: (environmentId, organizationId, params) =>
      updateWebEnvironment(environmentId, organizationId, params),
    restartActiveInstancesForEnvironments: (environmentIds) =>
      agentInstanceService.restartActiveInstancesForEnvironments(environmentIds),
    openAgentSession: (input) => openAgentSession(input),

    stopInstance: (instanceUid, organizationId) => stopInstance(instanceUid, organizationId),
    stopInstanceRuntime: (instance, mode) => agentInstanceService.stopInstanceRuntime(instance, mode),
    restartInstanceRuntime: (instance) => agentInstanceService.restartInstanceRuntime(instance),
    deleteInstance: (instance) => agentInstanceService.deleteInstance(instance),
    stopInstancesForEnvironments: (environmentIds, options) => stopInstancesForEnvironments(environmentIds, options),
    deleteEnvironment: (environmentId) => deleteEnvironment(environmentId),
    closeAcpConnectionsForEnvironments: (environmentIds) => closeAcpConnectionsForEnvironments(environmentIds),
    closeAllAcpConnections: () => closeAllAcpConnections(),
    closeAllRelayConnections: () => closeAllRelayConnections(),

    getOwnedEnvironment: (environmentId, organizationId, userId, role) =>
      getOwnedEnvironment(environmentId, organizationId, userId, role),
    listEnvironments: (organizationId, viewerUserId) => listEnvironmentsWithInstances(organizationId, viewerUserId),
    getEnvironmentBySecret: (secret) => getEnvironmentBySecret(secret),
    findRunningInstanceByEnvironment: (environmentId, userId) =>
      findRunningInstanceByEnvironment(environmentId, userId),
    listRuntimeInstances: (organizationId) => listRuntimeInstances(organizationId),
    getRuntimeInstance: (instanceUid, userId) => getInstance(instanceUid, userId),
    getOwnedInstance: (instanceUid, ownerUserId) => agentInstanceService.getOwnedInstance(instanceUid, ownerUserId),
    listOwnedInstances: (ownerUserId, environmentId) => agentInstanceService.listInstances(ownerUserId, environmentId),
    getRuntimeSnapshot: (instanceUid) => agentInstanceService.getRuntimeSnapshot(instanceUid),
    listInstanceActivity: (now, organizationId, showError) =>
      listInstanceActivitySnapshotsWithUsers(now, organizationId, showError),
    touchInstanceActivity: (instanceId, message, at) => touchInstanceActivity(instanceId, message, at),
    markInstanceRelayAttached: (instanceId, at) => markInstanceRelayAttached(instanceId, at),
    markInstanceRelayDetached: (instanceId, at) => markInstanceRelayDetached(instanceId, at),
    refreshInstanceEnvironment: (instanceId, environmentId, userId) =>
      refreshInstanceEnvironment(instanceId, environmentId, userId),
    getSession: (sessionId) => getSession(sessionId),
    resolveExistingSessionId: (sessionId) => resolveExistingSessionId(sessionId),
    updateSessionStatus: (sessionId, status) => updateSessionStatus(sessionId, status),

    cleanupInstancesForMachine: (machineId) => cleanupOrchestrationInstancesForMachine(machineId),
    unregisterInstance: (instanceUid) => globalInstanceRegistry.unregisterAndDeleteCounter(instanceUid),
    terminateLocalDeadInstance: (instanceId) => terminateLocalDeadInstance(instanceId),
    startIdleMonitor: () => startAcpIdleMonitor(),
    stopIdleMonitor: () => stopAcpIdleMonitor(),
    shutdown: () => agentInstanceService.shutdownRuntimes(),
  };

  return {
    ...port,
    session: {
      connectRelay: (instanceId, sessionId) => connectAgentRelay(instanceId, sessionId),
      createAgentSession: (config) => createAgentSession(config),
      createPromptTurn: (session, sessionId) => createPromptTurn(session, sessionId),
      startPromptTurn: (options) => startPromptTurn(options),
      sendToAgentWs: (agentId, message) => sendToAgentWs(agentId, message),
      sendToInstanceRelay: (instanceId, data) => sendToInstanceRelay(instanceId, data),
    },
  };
}

let boundRuntime: AgentRuntime | null = null;

/**
 * 创建 Runtime 模块实例。
 *
 * 幂等：内部持有的都是模块级单例，重复调用返回同一入口，不产生第二份运行状态（与
 * `createMachineModule` / `createSandboxModule` 同口径）。首次创建时完成 `bindAgentRuntime`，
 * 使 `getBoundAgentRuntime()` 可作为「宿主装配已完成」的判据——装配未走到 Runtime 时，
 * 消费方拿到的是明确的「未绑定」失败，而不是一个依赖尚未就绪的入口。
 *
 * 同时在本组合根绑定实例生命周期所需的编排操作（`AgentInstanceRuntimeOperations`，§4.6）：
 * 那是本包的内部装配 seam，不是对外 port——此前由宿主把包自己导出的
 * `spawnInstanceViaController` / `stopInstanceViaController` 再转发回来绑定，宿主只是中间人。
 * 放在这里之后，宿主只表达「装配 Runtime 模块」，不再复述本包的内部接线。
 */
export function createAgentRuntimeModule(): AgentRuntimeModule {
  if (!boundRuntime) {
    boundRuntime = createAgentRuntime();
    // 只在首次装配时绑定：重复调用不得覆盖用例或宿主后置绑定的替身（同 `bind*Port` 的一次装配语义）。
    bindAgentInstanceRuntimeOperations({
      spawnInstance: spawnInstanceViaController,
      stopInstance: stopInstanceViaController,
      hasActiveInstance: (instanceUid) =>
        getOrchestrationController()
          .listInstances()
          .some((instance) => instance.instanceId === instanceUid),
    });
  }
  return { id: "agent-runtime", runtime: boundRuntime };
}

/**
 * 宿主在装配阶段绑定运行入口（与 `bind*Port` 同口径：一次装配，全局共享）。
 *
 * 重复绑定不同实例会抛错——两套运行入口意味着两套绑定状态，排查时无法区分是哪一个在生效。
 */
export function bindAgentRuntime(runtime: AgentRuntime): void {
  if (boundRuntime && boundRuntime !== runtime) {
    throw new Error("AgentRuntime has already been bound");
  }
  boundRuntime = runtime;
}

/**
 * 取已装配的运行入口。
 *
 * 未装配即失败，不隐式回退为「现场构造一个」——隐式构造会让消费方在宿主尚未完成装配
 * （例如模块配置、宿主 port 未就绪）时拿到一个看似可用、实际会在调用中途失败的入口。
 */
export function getBoundAgentRuntime(): AgentRuntime {
  if (!boundRuntime) throw new Error("AgentRuntime has not been bound");
  return boundRuntime;
}

/** 测试用：解绑，防止测试进程内的装配状态泄漏。 */
export function resetAgentRuntimeForTest(): void {
  boundRuntime = null;
}

export type {
  AgentInstanceRecord,
  AgentSession,
  AutomaticInstanceSelection,
  PromptTurn,
  PromptTurnStartOptions,
  RuntimeSnapshot,
  RuntimeStopMode,
  SpawnedInstance,
};
