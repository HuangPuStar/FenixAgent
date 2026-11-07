/**
 * 同 server epoch 重连的服务端对账回归。
 *
 * 覆盖：短暂断连不删除 runtime 映射（1s/30s）、同 epoch register 走 inventory/reconcile、
 * `reconcile_confirmed` 收敛未确认实例、跨 epoch 仍 clean-slate、旧连接被 fence，
 * 以及断连期间到达的 stop 意图在重连后补发。定时器用 Bun fake timers 推进，不真实等待 30 秒。
 */

import { afterEach, beforeEach, describe, expect, jest, mock, test } from "bun:test";
import type { CoreRuntimeFacade } from "@fenix/core";
import type { AgentController } from "@fenix/orchestration";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createWsRemoteTransport, MACHINE_PROTOCOL_VERSION, SERVER_EPOCH } from "@fenix/remote-runtime";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import {
  agentInstanceService,
  bindAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../server/services/agent-instance-service";
import { bindCoreRuntimePort, type RegisterRemoteNodeOptions } from "../server/services/core-runtime-port";
import {
  handleAcpWsClose,
  handleAcpWsOpen,
  initializeAgentRuntimeModuleConfig,
  listAcpConnections,
  resetCoreRuntimePortForTest,
  stubMachineRegistryPort,
} from "../server/testing";
import {
  bindAcpInstanceActivityPort,
  closeAllAcpConnections,
  findMachineConnectionById,
  handleAcpWsMessage,
  resetAcpInstanceActivityPort,
  resetMachineDisconnectSchedulingForTest,
} from "../server/transport/acp-ws-handler";
import {
  bindRelayLifecyclePort,
  type RelayLifecyclePort,
  resetRelayLifecyclePort,
  tryGetRelayLifecyclePort,
} from "../server/transport/relay/lifecycle-port";
import {
  resetOrchestrationMachineCleanupDeps,
  setOrchestrationMachineCleanupDeps,
} from "../services/orchestration-machine-cleanup";
import { getAgentNodeService } from "../transport/agent-node-bridge";
import type { WsConnection } from "../types/ws-types";

const MACHINE_ID = "mach_same_epoch";
const MACHINE_USER = "user_same_epoch";

interface FakeCoreInstance {
  instanceId: string;
  nodeId: string;
  status: string;
  runtimeGeneration: number;
  serverEpoch: string;
  engineType: string;
}

const coreInstances = new Map<string, FakeCoreInstance>();
const deletedInstanceIds: string[] = [];
const registeredNodes = new Map<string, { id: string; mode: string; engineTypes: string[]; status: string }>();
const registerCalls: Array<{ machineId: string; options?: RegisterRemoteNodeOptions }> = [];
const unregisterCalls: string[] = [];
const machineHeartbeats: string[] = [];
const transports = new Map<string, ReturnType<typeof createWsRemoteTransport>>();
const connectedMachineIds: string[] = [];
let savedRelayLifecyclePort: RelayLifecyclePort | null = null;

const facade = {
  getInstance: (instanceId: string) => coreInstances.get(instanceId) ?? null,
  listInstances: () => [...coreInstances.values()],
  deleteInstance: (instanceId: string) => {
    deletedInstanceIds.push(instanceId);
    coreInstances.delete(instanceId);
  },
  getNode: (machineId: string) => registeredNodes.get(machineId) ?? null,
  updateNodeStatus: (machineId: string, status: string) => {
    const node = registeredNodes.get(machineId);
    if (node) node.status = status;
  },
  registerNode: (node: { id: string; mode: string; engineTypes: string[]; status: string }) => {
    registeredNodes.set(node.id, node);
  },
} as unknown as CoreRuntimeFacade;

function createMockWs(): WsConnection & { sent: string[]; closeCalls: number } {
  const sent: string[] = [];
  const ws = {
    readyState: 1,
    sent,
    closeCalls: 0,
    onmessage: null,
    send: mock((data: string) => {
      sent.push(data);
    }),
    close: mock(() => {
      ws.readyState = 3;
      ws.closeCalls += 1;
    }),
  };
  return ws as unknown as WsConnection & { sent: string[]; closeCalls: number };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

function createInstance(id: string): AgentInstanceRecord {
  return {
    id,
    environmentId: "env_same_epoch",
    ownerUserId: MACHINE_USER,
    creationSource: "api",
    name: "primary",
    isDefault: false,
    createdByUserId: MACHINE_USER,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

async function openConnection(
  wsId: string,
  register: Record<string, unknown>,
): Promise<ReturnType<typeof createMockWs>> {
  const ws = createMockWs();
  handleAcpWsOpen(ws, wsId, MACHINE_USER, null, true);
  connectedMachineIds.push(MACHINE_ID);
  await handleAcpWsMessage(ws, wsId, register);
  await settle();
  return ws;
}

function registeredFrame(ws: { sent: string[] }): Record<string, unknown> {
  const frame = ws.sent
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .find((msg) => msg.type === "registered");
  if (!frame) throw new Error("registered frame not sent");
  return frame;
}

function inventoryFor(instanceId: string, generation: number): Array<Record<string, unknown>> {
  return [
    {
      instance_uid: instanceId,
      instance_id: instanceId,
      runtime_generation: generation,
      server_epoch: SERVER_EPOCH,
      session_id: "ses-1",
      process_alive: true,
    },
  ];
}

beforeEach(() => {
  initializeAgentRuntimeModuleConfig({ wsKeepaliveInterval: 30, machineReconnectGraceMs: 45_000 });
  coreInstances.clear();
  deletedInstanceIds.length = 0;
  registeredNodes.clear();
  registerCalls.length = 0;
  unregisterCalls.length = 0;
  machineHeartbeats.length = 0;
  transports.clear();
  connectedMachineIds.length = 0;

  stubMachineRegistryPort({
    registerMachine: async ({ machineId }) => ({ id: machineId, isNew: false }),
    disconnectMachine: async () => {},
    startHeartbeat: () => {},
    handleHeartbeat: async (machineId) => {
      machineHeartbeats.push(machineId);
    },
    stopHeartbeat: () => {},
  });
  bindAgentInstanceRuntimeOperations({
    spawnInstance: async () => {},
    stopInstance: async () => {},
    hasActiveInstance: () => false,
  });
  bindAcpInstanceActivityPort(() => {});
  setOrchestrationMachineCleanupDeps({
    getOrchestrationController: () => ({ stopInstancesByMachineId: () => [] }) as unknown as AgentController,
    reclaimYjsDocs: async () => {},
  });
  // 清理尾部会 fire-and-forget 关闭前端 relay；未绑定端口会把动态 import 的拒绝漏到后续用例。
  if (!savedRelayLifecyclePort) savedRelayLifecyclePort = tryGetRelayLifecyclePort();
  bindRelayLifecyclePort({
    closeClientsByInstance: () => {},
    reclaimInstanceRealtimeResources: async () => {},
    closeAllClients: () => {},
  });
  resetCoreRuntimePortForTest();
  bindCoreRuntimePort({
    getCoreRuntime: () => facade,
    registerRemoteNode: (machineId, ws, entry, _engineTypes, options) => {
      registerCalls.push({ machineId, options });
      const previous = transports.get(machineId);
      if (options?.preserveRuntime && previous?.rebind) {
        previous.rebind(ws);
        entry.remoteTransport = previous;
        return;
      }
      previous?.close("replaced");
      const transport = createWsRemoteTransport(ws);
      transports.set(machineId, transport);
      entry.remoteTransport = transport;
    },
    unregisterRemoteNode: (machineId) => {
      unregisterCalls.push(machineId);
      transports.get(machineId)?.close("unregistered");
      transports.delete(machineId);
      registeredNodes.delete(machineId);
      // 宿主实现会经 cleanupMachineInstances 收敛 core 实例；测试端口保持相同语义。
      for (const instance of [...coreInstances.values()]) {
        if (instance.nodeId !== machineId) continue;
        agentInstanceService.handleRuntimeDisconnect(instance.instanceId, instance.runtimeGeneration, machineId);
        deletedInstanceIds.push(instance.instanceId);
        coreInstances.delete(instance.instanceId);
      }
    },
  });
});

afterEach(() => {
  closeAllAcpConnections();
  resetMachineDisconnectSchedulingForTest();
  jest.useRealTimers();
  for (const machineId of connectedMachineIds) getAgentNodeService().notifyNodeDisconnected(machineId);
  resetAgentInstanceRuntimeOperations();
  resetAcpInstanceActivityPort();
  resetOrchestrationMachineCleanupDeps();
  if (savedRelayLifecyclePort) bindRelayLifecyclePort(savedRelayLifecyclePort);
  else resetRelayLifecyclePort();
  savedRelayLifecyclePort = null;
  resetCoreRuntimePortForTest();
  resetAllStubs();
});

/** 建立一条已完成 clean-slate 的机器连接，并把一个 running 实例放进 coordinator 与 core。 */
async function bootstrap(instanceId: string): Promise<{ ws: ReturnType<typeof createMockWs>; wsId: string }> {
  const wsId = "ws_bootstrap";
  const ws = await openConnection(wsId, {
    type: "register",
    agent_name: "same-epoch-machine",
    protocol_version: MACHINE_PROTOCOL_VERSION,
    machine_id: MACHINE_ID,
  });
  expect(registeredFrame(ws).clean_slate_required).toBe(true);
  await handleAcpWsMessage(ws, wsId, {
    type: "clean_slate_confirmed",
    protocol_version: MACHINE_PROTOCOL_VERSION,
    server_epoch: SERVER_EPOCH,
  });
  await settle();

  coreInstances.set(instanceId, {
    instanceId,
    nodeId: MACHINE_ID,
    status: "running",
    runtimeGeneration: 1,
    serverEpoch: SERVER_EPOCH,
    engineType: "peri",
  });
  const instance = createInstance(instanceId);
  await agentInstanceService.ensureInstanceRuntime(instance);
  // ensure 使用 isRuntimeReady 读取 core；把代次与 core 对齐，便于断言跨重连不变。
  expect(agentInstanceService.getRuntimeSnapshot(instanceId).state).toBe("running");
  return { ws, wsId };
}

describe("same-epoch machine reconnect", () => {
  // 断网 1 秒和 30 秒都在宽限期内：runtime 映射、PID 对应代次与在途 turn 身份必须保留。
  test("1s and 30s outages keep runtime mapping and turn identity", async () => {
    jest.useFakeTimers();
    const instanceId = "inst_same_epoch";
    const { ws, wsId } = await bootstrap(instanceId);
    const generation = agentInstanceService.getRuntimeSnapshot(instanceId).runtimeGeneration;
    const observedSessions: string[] = [];
    transports.get(MACHINE_ID)?.onSessionMessage((_instanceId, sessionId) => observedSessions.push(sessionId));

    handleAcpWsClose(ws, wsId, 1006, "network loss");
    jest.advanceTimersByTime(1000);
    await settle();
    expect(unregisterCalls).toEqual([]);
    expect(agentInstanceService.getRuntimeSnapshot(instanceId).state).toBe("running");
    expect(coreInstances.has(instanceId)).toBe(true);

    const secondWsId = "ws_reconnect_1s";
    const second = await openConnection(secondWsId, {
      type: "register",
      agent_name: "same-epoch-machine",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      machine_id: MACHINE_ID,
      server_epoch: SERVER_EPOCH,
      instances: inventoryFor(instanceId, 1),
    });
    const secondRegistration = registeredFrame(second);
    expect(secondRegistration.clean_slate_required).toBe(false);
    expect(secondRegistration.reconcile).toMatchObject({
      accepted_instances: [{ instance_uid: instanceId, runtime_generation: 1 }],
      rejected_instances: [],
    });
    expect(registerCalls.at(-1)?.options?.preserveRuntime).toBe(true);
    expect(unregisterCalls).toEqual([]);
    expect(agentInstanceService.getRuntimeSnapshot(instanceId).state).toBe("running");
    expect(agentInstanceService.getRuntimeSnapshot(instanceId).runtimeGeneration).toBe(generation);

    await handleAcpWsMessage(second, secondWsId, {
      type: "reconcile_confirmed",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      server_epoch: SERVER_EPOCH,
      instances: inventoryFor(instanceId, 1),
    });
    await settle();
    expect(findMachineConnectionById(MACHINE_ID)?.cleanSlateConfirmed).toBe(true);
    await handleAcpWsMessage(second, secondWsId, {
      type: "relay",
      instance_id: instanceId,
      instance_uid: instanceId,
      runtime_generation: 1,
      server_epoch: SERVER_EPOCH,
      session_id: "ses-1",
      payload: { type: "status" },
    });
    await settle();
    expect(observedSessions).toEqual(["ses-1"]);

    // 第二次断网持续 30 秒，仍小于宽限期。
    handleAcpWsClose(second, secondWsId, 1006, "network loss 30s");
    jest.advanceTimersByTime(30_000);
    await settle();
    expect(unregisterCalls).toEqual([]);
    expect(coreInstances.has(instanceId)).toBe(true);

    const thirdWsId = "ws_reconnect_30s";
    const third = await openConnection(thirdWsId, {
      type: "register",
      agent_name: "same-epoch-machine",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      machine_id: MACHINE_ID,
      server_epoch: SERVER_EPOCH,
      instances: inventoryFor(instanceId, 1),
    });
    expect(registeredFrame(third).clean_slate_required).toBe(false);
    expect(agentInstanceService.getRuntimeSnapshot(instanceId).runtimeGeneration).toBe(generation);

    // 宽限期到期且无 owner：才回到原有断连收口。
    handleAcpWsClose(third, thirdWsId, 1006, "never reconnected");
    jest.advanceTimersByTime(45_000);
    await settle();
    expect(unregisterCalls).toEqual([MACHINE_ID]);
    expect(deletedInstanceIds).toContain(instanceId);
    expect(agentInstanceService.getRuntimeSnapshot(instanceId).state).toBe("unknown");
  });

  // 旧 epoch 的运行事实不可确认：注册仍要求 clean-slate，且待定清理立即执行。
  test("cross-epoch register still requires clean slate and flushes old runtime", async () => {
    jest.useFakeTimers();
    const instanceId = "inst_cross_epoch";
    const { ws, wsId } = await bootstrap(instanceId);

    handleAcpWsClose(ws, wsId, 1006, "network loss");
    jest.advanceTimersByTime(1000);

    const next = await openConnection("ws_cross_epoch", {
      type: "register",
      agent_name: "same-epoch-machine",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      machine_id: MACHINE_ID,
      server_epoch: "stale-server-epoch",
      instances: inventoryFor(instanceId, 1),
    });
    expect(registeredFrame(next).clean_slate_required).toBe(true);
    expect(unregisterCalls).toEqual([MACHINE_ID]);
    expect(deletedInstanceIds).toContain(instanceId);
    expect(agentInstanceService.getRuntimeSnapshot(instanceId).state).toBe("unknown");
    expect(registerCalls.at(-1)?.options?.preserveRuntime).toBeUndefined();
  });

  // 新 owner 接管时旧连接必须被关闭并从连接表移除，旧帧不得再触发心跳或生命周期。
  test("new same-epoch owner fences the previous connection", async () => {
    const instanceId = "inst_fenced";
    const { ws, wsId } = await bootstrap(instanceId);
    const heartbeatsBefore = machineHeartbeats.length;

    const next = await openConnection("ws_fenced_new", {
      type: "register",
      agent_name: "same-epoch-machine",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      machine_id: MACHINE_ID,
      server_epoch: SERVER_EPOCH,
      instances: inventoryFor(instanceId, 1),
    });

    expect(ws.closeCalls).toBe(1);
    expect(listAcpConnections().filter((connection) => connection.machineId === MACHINE_ID)).toHaveLength(1);
    expect(findMachineConnectionById(MACHINE_ID)?.wsId).toBe("ws_fenced_new");
    await handleAcpWsMessage(ws, wsId, { type: "heartbeat" });
    await settle();
    expect(machineHeartbeats.length).toBe(heartbeatsBefore);
    expect(registeredFrame(next).clean_slate_required).toBe(false);
  });

  // 机器最终确认清单才是权威：服务端已接受但未确认的实例必须按死亡事实收敛。
  test("reconcile confirmation removes accepted instances the machine no longer reports", async () => {
    jest.useFakeTimers();
    const keptInstanceId = "inst_confirmed";
    const droppedInstanceId = "inst_unconfirmed";
    const { ws, wsId } = await bootstrap(keptInstanceId);
    coreInstances.set(droppedInstanceId, {
      instanceId: droppedInstanceId,
      nodeId: MACHINE_ID,
      status: "running",
      runtimeGeneration: 2,
      serverEpoch: SERVER_EPOCH,
      engineType: "peri",
    });

    handleAcpWsClose(ws, wsId, 1006, "network loss");
    jest.advanceTimersByTime(1000);

    const next = await openConnection("ws_confirm_subset", {
      type: "register",
      agent_name: "same-epoch-machine",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      machine_id: MACHINE_ID,
      server_epoch: SERVER_EPOCH,
      instances: [...inventoryFor(keptInstanceId, 1), ...inventoryFor(droppedInstanceId, 2)],
    });
    const registration = registeredFrame(next);
    expect(registration.clean_slate_required).toBe(false);
    expect((registration.reconcile as { accepted_instances: unknown[] }).accepted_instances).toHaveLength(2);

    await handleAcpWsMessage(next, "ws_confirm_subset", {
      type: "reconcile_confirmed",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      server_epoch: SERVER_EPOCH,
      instances: inventoryFor(keptInstanceId, 1),
    });
    await settle();

    expect(deletedInstanceIds).toEqual([droppedInstanceId]);
    expect(coreInstances.has(keptInstanceId)).toBe(true);
    expect(coreInstances.has(droppedInstanceId)).toBe(false);
    expect(agentInstanceService.getRuntimeSnapshot(droppedInstanceId).state).toBe("stopped");
  });

  // 断连期间到达的 stop 意图不能丢失：重连后补发并在 stop_result 到达时完成。
  test("stop intent arriving during disconnect is delivered after reconcile", async () => {
    jest.useFakeTimers();
    const instanceId = "inst_stop_during_disconnect";
    const { ws, wsId } = await bootstrap(instanceId);
    const transport = transports.get(MACHINE_ID);
    expect(transport).toBeDefined();

    handleAcpWsClose(ws, wsId, 1006, "network loss");
    jest.advanceTimersByTime(1000);

    const stopping = transport?.sendAndWait({
      type: "stop",
      instance_id: instanceId,
      instance_uid: instanceId,
      runtime_generation: 1,
      server_epoch: SERVER_EPOCH,
    });
    await expect(
      transport?.sendAndWait({
        type: "prepare",
        instance_id: instanceId,
        instance_uid: instanceId,
        runtime_generation: 1,
        server_epoch: SERVER_EPOCH,
      }),
    ).rejects.toThrow("disconnected");

    const next = await openConnection("ws_stop_reconcile", {
      type: "register",
      agent_name: "same-epoch-machine",
      protocol_version: MACHINE_PROTOCOL_VERSION,
      machine_id: MACHINE_ID,
      server_epoch: SERVER_EPOCH,
      instances: inventoryFor(instanceId, 1),
    });
    await settle();

    const stopFrame = next.sent
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((frame) => frame.type === "stop");
    expect(stopFrame).toBeDefined();
    expect(stopFrame?.request_id).toBeString();

    await handleAcpWsMessage(next, "ws_stop_reconcile", {
      type: "stop_result",
      request_id: stopFrame?.request_id,
      instance_id: instanceId,
      instance_uid: instanceId,
      runtime_generation: 1,
      server_epoch: SERVER_EPOCH,
      status: "ok",
    });
    await expect(stopping).resolves.toMatchObject({ status: "ok" });
  });
});
