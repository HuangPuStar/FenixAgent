/**
 * 机器 clean-slate 确认复位该机器 unknown runtime 的**接线**测试。
 *
 * 协调器自身的复位语义（只复位「归属该机器 + unknown + 无在飞操作」的条目）由
 * `server/__tests__/agent-instance-runtime-coordinator.test.ts` 覆盖；本文件补的是「谁在什么时机调用复位」。
 * 只测协调器会漏掉调用点放错位置这类错误——复位若被放进 `activateRemoteMachine` 的 try 块内，宿主装配
 * 抛错时复位会被一并跳过，而 heartbeat 自愈路径只补装配、不补复位，同一故障会换个形式继续卡死。
 *
 * machine 连接按 `acp-machine-connection-lookup.test.ts` 的手法建立（handleAcpWsOpen + register +
 * clean_slate_confirmed）。断连一侧既有直接驱动 `agentInstanceService.handleRuntimeDisconnect` 的用例，也有经
 * 两条真实清理入口（`triggerMachineCleanupByMachineId` / `handleAcpWsClose`）驱动的用例——后者钉住清理传给
 * 协调器的 `machineId` 实参。`machine-cleanup-node-dispatch.test.ts` 只覆盖清理对编排域 AgentNode 的通知
 * （sweep 把 stale connected 节点纠正为 disconnected），不涉及协调器条目的机器归属，二者不互相替代。
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { MACHINE_PROTOCOL_VERSION, SERVER_EPOCH } from "@fenix/remote-runtime";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import {
  agentInstanceService,
  bindAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../server/services/agent-instance-service";
import { bindCoreRuntimePort } from "../server/services/core-runtime-port";
import {
  getBoundCoreRuntimePort,
  handleAcpWsClose,
  handleAcpWsOpen,
  initializeAgentRuntimeModuleConfig,
  listAcpConnections,
  resetCoreRuntimePortForTest,
  stubCoreRuntimeFacade,
  stubMachineRegistryPort,
} from "../server/testing";
import { handleAcpWsMessage, triggerMachineCleanupByMachineId } from "../server/transport/acp-ws-handler";
import {
  bindRelayLifecyclePort,
  type RelayLifecyclePort,
  resetRelayLifecyclePort,
  tryGetRelayLifecyclePort,
} from "../server/transport/relay/lifecycle-port";
import { getAgentNodeService } from "../transport/agent-node-bridge";
import type { WsConnection } from "../types/ws-types";

const MACHINE_USER_ID = "user_clean_slate";

/** 本用例建立过连接的 machineId，afterEach 统一通知编排域断连（激活阶段会隐式接管节点）。 */
const connectedMachineIds: string[] = [];

/** 清理尾部叫停 relay 客户端的实例 uid（经 relay 生命周期端口记录）。 */
const relayClosedInstanceIds: string[] = [];

/** 本文件替换前的 relay 生命周期端口绑定，afterEach 原样还原（见 afterEach 注释）。 */
let savedRelayLifecyclePort: RelayLifecyclePort | null = null;
let relayPortStubbed = false;

beforeEach(() => {
  // 内含 resetAllStubs：模块配置与 DB 替身按「每个用例重新装配」处理（WS 保活间隔沿用迁移前的 30s）。
  initializeAgentRuntimeModuleConfig({ wsKeepaliveInterval: 30 });
  stubMachineRegistryPort({
    registerMachine: async ({ machineId }) => ({ id: machineId, isNew: true }),
    disconnectMachine: async () => {},
    startHeartbeat: () => {},
    handleHeartbeat: async () => {},
    stopHeartbeat: () => {},
  });
  // 协调器的 hasActiveRuntime 会读 core facade：无 core 实例时判定只落到编排层，避免读到 null 崩溃。
  stubCoreRuntimeFacade({ getInstance: () => null });
  // 未绑定时 adapter.start 抛「Agent instance runtime operations are not bound」，而非用例要断言的复位失败。
  bindAgentInstanceRuntimeOperations({
    spawnInstance: async () => {},
    stopInstance: async () => {},
    hasActiveInstance: () => false,
  });
  // 两条清理入口的尾部会 fire-and-forget 关停 relay 客户端，端口未绑定时那里抛错；用例只测清理与归属。
  relayClosedInstanceIds.length = 0;
  if (!relayPortStubbed) {
    savedRelayLifecyclePort = tryGetRelayLifecyclePort();
    relayPortStubbed = true;
  }
  bindRelayLifecyclePort({
    closeClientsByInstance: (instanceId) => {
      relayClosedInstanceIds.push(instanceId);
    },
    reclaimInstanceRealtimeResources: async () => {},
    closeAllClients: () => {},
  });
});

afterEach(() => {
  for (const machineId of connectedMachineIds) getAgentNodeService().notifyNodeDisconnected(machineId);
  connectedMachineIds.length = 0;
  resetAgentInstanceRuntimeOperations();
  // 还原前一次绑定，而不是 resetRelayLifecyclePort() 置空：默认绑定是 chat-channel-bootstrap 的模块级
  // 副作用，同进程后续测试文件再 import 只会命中模块缓存、不会重新绑定，置空会让它们静默失去 relay 清理
  // 能力（实测 acp-idle-monitor 的回收用例因此不再调用 stopInstance）。
  if (savedRelayLifecyclePort) bindRelayLifecyclePort(savedRelayLifecyclePort);
  else resetRelayLifecyclePort();
  resetAllStubs();
});

/** 最小假连接：本文件只经 handleAcpWsOpen/handleAcpWsMessage 驱动，不信令 WS 帧。 */
function createMockWs(): WsConnection {
  return {
    readyState: 1,
    send: mock((_data: string | Uint8Array) => {}),
    close: mock((_code?: number, _reason?: string) => {}),
  } as unknown as WsConnection;
}

/** 构造实例记录：id 在协调器里只作条目键（本层不经 `isAgentInstanceUid` 校验），取可读且用例间不重叠的值。 */
function createInstance(id: string): AgentInstanceRecord {
  return {
    id,
    environmentId: "env_clean_slate",
    ownerUserId: MACHINE_USER_ID,
    creationSource: "api",
    name: "primary",
    isDefault: false,
    createdByUserId: MACHINE_USER_ID,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * 驱动 ensure 后立刻断连（机器 WS 断开时 handler 对每个实例做的事），返回断连前的世代。
 * 只驱动这一条通知：WS 关闭 / sweep 两条触发链路已由 `machine-cleanup-node-dispatch.test.ts` 覆盖。
 */
async function ensureThenDisconnect(instanceId: string, machineId: string): Promise<AgentInstanceRecord> {
  const instance = createInstance(instanceId);
  await agentInstanceService.ensureInstanceRuntime(instance);
  const generation = agentInstanceService.getRuntimeSnapshot(instance.id).runtimeGeneration;
  agentInstanceService.handleRuntimeDisconnect(instance.id, generation, machineId);
  return instance;
}

/** 建立 machine 连接并完成注册；clean-slate 确认被守卫在「已注册」之后。 */
async function connectMachine(wsId: string, machineId: string): Promise<WsConnection> {
  const ws = createMockWs();
  handleAcpWsOpen(ws, wsId, MACHINE_USER_ID, null, true);
  connectedMachineIds.push(machineId);

  // register 是 fire-and-forget（handler 内不 await），这里 await 一次让注册流程推进到写回 entry.machineId。
  await handleAcpWsMessage(ws, wsId, {
    type: "register",
    agent_name: "clean-slate-test-machine",
    protocol_version: MACHINE_PROTOCOL_VERSION,
    machine_id: machineId,
  });
  // 显式确认已落表：未注册时 clean-slate 会被守卫按 4406 拒绝，静默走过会把「没注册上」误判成复位结果。
  expect(listAcpConnections().find((connection) => connection.wsId === wsId)?.machineId).toBe(machineId);
  return ws;
}

/** 发送 clean-slate 确认：协议版本与 server epoch 任一不符都会被 4406 关闭，进不到确认分支。 */
async function confirmCleanSlate(ws: WsConnection, wsId: string): Promise<void> {
  await handleAcpWsMessage(ws, wsId, {
    type: "clean_slate_confirmed",
    protocol_version: MACHINE_PROTOCOL_VERSION,
    server_epoch: SERVER_EPOCH,
  });
}

/** 清理入口的取数面：按 nodeId 过滤 core 实例，字段名以 handler 实际读取的为准。 */
function stubDisconnectedCoreInstances(machineId: string, instanceId: string, runtimeGeneration: number): void {
  stubCoreRuntimeFacade({
    getInstance: () => null,
    listInstances: () => [{ instanceId, nodeId: machineId, runtimeGeneration, serverEpoch: SERVER_EPOCH }],
  });
}

/**
 * 等清理尾部那条 fire-and-forget 的 relay 断连落地：它既证明清理跑到了尾部，也让 afterEach 解绑端口发生在它
 * 之后——`.then` 里取未绑定的端口会变成挂在后续用例上的未处理拒绝。
 */
async function waitForRelayClose(instanceId: string): Promise<void> {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline && !relayClosedInstanceIds.includes(instanceId)) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  expect(relayClosedInstanceIds).toContain(instanceId);
}

describe("machine clean slate recovery", () => {
  // 机器确认 clean slate 是「旧 runtime 已终止」的唯一可信信号，接线到协调器后进入实例不应再被 runtime gate 拒绝。
  test("clean slate confirmation resolves unknown runtimes of that machine", async () => {
    const machineId = "mach_clean_slate_001";
    const instance = await ensureThenDisconnect("inst_clean_slate_001", machineId);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("unknown");

    const wsId = "ws_clean_slate_001";
    const ws = await connectMachine(wsId, machineId);
    await confirmCleanSlate(ws, wsId);

    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("stopped");
  });

  // 协议确认（机器已清理进程）与宿主装配是两个阶段，装配失败不能让复位被跳过，否则同一故障会以其它形式卡死。
  test("activation failure does not skip clean slate recovery", async () => {
    const machineId = "mach_clean_slate_002";
    const instance = await ensureThenDisconnect("inst_clean_slate_002", machineId);

    // 失败注入口只能是 core 端口本身：stubCoreRuntimeFacade 只替换 getCoreRuntime，远端节点注册仍走它保留的
    // 旧端口（包内单跑为兜底空实现），因此整份重绑一个会抛错的端口来制造「装配阶段失败」。
    const registerRemoteNode = mock(() => {
      throw new Error("remote node registration failed");
    });
    const port = { ...getBoundCoreRuntimePort(), registerRemoteNode };
    resetCoreRuntimePortForTest();
    bindCoreRuntimePort(port);

    const wsId = "ws_clean_slate_002";
    const ws = await connectMachine(wsId, machineId);
    await confirmCleanSlate(ws, wsId);

    // 先确认失败分支真的被走到，否则下面的 stopped 断言可能来自「根本没抛错」。
    expect(registerRemoteNode).toHaveBeenCalledTimes(1);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("stopped");
  });

  // 一次确认只能覆盖它自己那台机器，跨机放行会允许与旧进程并存的重启。
  test("clean slate confirmation does not resolve unknown runtimes of other machines", async () => {
    const instance = await ensureThenDisconnect("inst_clean_slate_003", "mach_clean_slate_003a");
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("unknown");

    const wsId = "ws_clean_slate_003";
    const ws = await connectMachine(wsId, "mach_clean_slate_003b");
    await confirmCleanSlate(ws, wsId);

    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("unknown");
  });

  // 断连清理必须把「该机器」的 machineId 交给协调器：归属写错机器时，本机的 clean-slate 确认会放行别的机器上的
  // 未知条目（那条 runtime 可能与旧进程并存），真正的条目反而永远卡在 unknown。
  test("machine disconnect cleanup attributes unknown runtimes to that machine", async () => {
    const machineId = "mach_sweep_cleanup_001";
    const instance = createInstance("inst_sweep_cleanup_001");
    await agentInstanceService.ensureInstanceRuntime(instance);
    const generation = agentInstanceService.getRuntimeSnapshot(instance.id).runtimeGeneration;
    stubDisconnectedCoreInstances(machineId, instance.id, generation);

    // 调用前该机器不能有活跃连接：sweep 入口先做快速重连短路，命中即整段跳过（含归属写入）。
    triggerMachineCleanupByMachineId(machineId, "test: sweep cleanup");
    await waitForRelayClose(instance.id);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("unknown");

    // 归属断言必须排在「同一台机器确认」之前：复位成功后状态已是 stopped，那时再发别的机器的确认观察不到差异。
    const otherWsId = "ws_sweep_cleanup_other";
    const otherWs = await connectMachine(otherWsId, "mach_sweep_cleanup_other");
    await confirmCleanSlate(otherWs, otherWsId);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("unknown");

    const wsId = "ws_sweep_cleanup_001";
    const ws = await connectMachine(wsId, machineId);
    await confirmCleanSlate(ws, wsId);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("stopped");
  });

  // WS 关闭是另一条清理入口（handleAcpWsClose → performMachineCleanup），它同样要传该机器的 machineId：
  // 只有一条入口传对，另一条上的条目仍会卡 unknown，故障只是换了个触发条件。
  test("machine ws close cleanup attributes unknown runtimes to that machine", async () => {
    const machineId = "mach_wsclose_cleanup_001";
    const instance = createInstance("inst_wsclose_cleanup_001");
    await agentInstanceService.ensureInstanceRuntime(instance);
    const generation = agentInstanceService.getRuntimeSnapshot(instance.id).runtimeGeneration;
    stubDisconnectedCoreInstances(machineId, instance.id, generation);

    // 该机器先有一条活跃连接来驱动关闭事件；连接记录在清理前被删除，快速重连短路因此不生效。
    const wsId = "ws_wsclose_cleanup_001";
    const ws = await connectMachine(wsId, machineId);
    handleAcpWsClose(ws, wsId, 1006, "test: machine ws closed");
    await waitForRelayClose(instance.id);

    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("unknown");

    const reconnectedWsId = "ws_wsclose_cleanup_001_reconnect";
    const reconnectedWs = await connectMachine(reconnectedWsId, machineId);
    await confirmCleanSlate(reconnectedWs, reconnectedWsId);

    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("stopped");
  });
});
