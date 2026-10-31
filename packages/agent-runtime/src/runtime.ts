/** 对外运行入口：组合既有实例、会话和观测服务，不产生第二份生命周期状态。 */
import type {
  AgentRuntime,
  AgentRuntimeModule,
  AgentRuntimePort,
  ChatClientConnectionSnapshot,
} from "./runtime-contract";

export type * from "./runtime-contract";

import { agentInstanceRepo } from "./server/repositories/agent-instance";
import { environmentRepo } from "./server/repositories/environment";
import {
  findRunningInstanceByEnvironment,
  getInstance,
  listInstances as listRuntimeInstances,
  reclaimInstance,
  stopInstance,
} from "./server/services/agent-instance-runtime-projection";
import { agentInstanceService, bindAgentInstanceRuntimeOperations } from "./server/services/agent-instance-service";
import {
  createWebEnvironment,
  listEnvironmentsWithInstances,
  updateWebEnvironment,
} from "./server/services/environment-web";
import {
  closeAcpConnectionsForEnvironments,
  closeAllAcpConnections,
  listAcpConnections as listAcpConnectionSnapshots,
  sendToAgentWs,
} from "./server/transport/acp-ws-handler";
import { connectAgentRelay } from "./server/transport/agent-relay";
import { closeAllRelayConnections } from "./server/transport/relay";
import { listExternalRelayEntries } from "./server/transport/relay/external-relay";
import { sendToInstanceRelay } from "./server/transport/relay/relay-handler";
import {
  listInstanceActivitySnapshotsWithUsers,
  markInstanceRelayAttached,
  markInstanceRelayDetached,
  startAcpIdleMonitor,
  stopAcpIdleMonitor,
  touchInstanceActivity,
} from "./services/acp-idle-monitor";
import { createAgentSession, createPromptTurn, openAgentSession, startPromptTurn } from "./services/agent-chat-service";
import { getEnvironmentBySecret } from "./services/environment-acp";
import { deleteEnvironment, getOwnedEnvironment } from "./services/environment-core";
import { convergeMachineInstances } from "./services/machine-instance-cleanup";
import { getOrchestrationController } from "./services/orchestration-bootstrap";
import {
  refreshInstanceEnvironment,
  spawnInstanceViaController,
  stopInstancesForEnvironments,
  stopInstanceViaController,
  terminateLocalDeadInstance,
} from "./services/orchestration-instance";
import { getSession, resolveExistingSessionId, updateSessionStatus } from "./services/session";
import { getEventBus, removeEventBus } from "./transport/event-bus";

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
      await agentInstanceService.ensureInstanceRuntime(instance, input.signal, input.activation);
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
    reclaimInstance: (instanceUid, organizationId, generation, reason) =>
      reclaimInstance(instanceUid, organizationId, generation, reason),
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

    cleanupMachineInstances: (machineId, options) => convergeMachineInstances(machineId, options),
    terminateLocalDeadInstance: (instanceId, identity) => terminateLocalDeadInstance(instanceId, identity),
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
      getEventBus: (sessionId) => getEventBus(sessionId),
      removeEventBus: (sessionId) => removeEventBus(sessionId),
    },
    observe: {
      listAcpConnections: () => listAcpConnectionSnapshots(),
      listExternalRelayConnections: () => listExternalRelayEntries(),
      listChatClients: async () => {
        // 动态 import 的理由见 `AgentRuntimeObservability.listChatClients` 的注释。
        const { getChatChannelController } = await import("./server/services/chat-channel-bootstrap");
        const out: ChatClientConnectionSnapshot[] = [];
        getChatChannelController().registry.forEachClientEntry((wsId, client) => {
          out.push({
            wsId,
            userId: client.userId,
            agentId: client.agentId,
            instanceId: client.instanceId,
            rcsSessionId: client.rcsSessionId,
            acpSessionId: client.acpSessionId,
            openTime: client.openTime,
          });
        });
        return out;
      },
      getInstanceName: async (instanceUid) => (await agentInstanceRepo.getById(instanceUid))?.name,
      getEnvironmentRecord: (environmentId) => environmentRepo.getById(environmentId),
      listEnvironmentRecordsByOrganization: (organizationId) => environmentRepo.listByOrganizationId(organizationId),
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

export { acquireAgentExecution, markAgentExecutionIdleReclaimable } from "./services/agent-execution-admission";
export type { AgentTurnOutcome, AgentTurnTerminal } from "./services/agent-turn-events";
export { classifyAgentTurnEvent, iterateWithSignal, waitWithSignal } from "./services/agent-turn-events";
