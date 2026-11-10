/**
 * 远端子进程死亡 → 主服务运行实体回收 → 下一次 ensure 重启新代的接线测试。
 *
 * 机器侧只广播 `status connected:false`（machine 连接仍在），主服务必须按 runtimeGeneration
 * 删除 core 记录与活跃表条目并作废 Coordinator 运行事实；否则下一次 ensure 会复用仍标记
 * running 的 core 快照，重新进入时继续访问死连接。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import {
  agentInstanceService,
  bindAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../server/services/agent-instance-service";
import {
  initializeAgentRuntimeModuleConfig,
  resetCoreRuntimeFacadeStub,
  stubCoreRuntimeFacade,
} from "../server/testing";
import { connectAgentRelay } from "../server/transport/agent-relay";
import { globalInstanceRegistry } from "../services/instance-registry";
import { terminateRemoteDeadInstance } from "../services/orchestration-instance";

interface Snapshot {
  instanceId: string;
  nodeId: string;
  status: string;
  runtimeGeneration?: number;
  serverEpoch?: string;
}

interface FakeFacade {
  records: Map<string, Snapshot>;
  listeners: Set<(message: EngineRelayMessage) => void>;
  getInstance(instanceId: string): Snapshot | null;
  listInstances(): Snapshot[];
  deleteInstance(instanceId: string): boolean;
  connectInstanceRelay(input: { instanceId: string; sessionId: string }): Promise<unknown>;
}

function createFacade(): FakeFacade {
  const records = new Map<string, Snapshot>();
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  return {
    records,
    listeners,
    getInstance: (instanceId) => records.get(instanceId) ?? null,
    listInstances: () => [...records.values()],
    deleteInstance: (instanceId) => records.delete(instanceId),
    async connectInstanceRelay() {
      return {
        state: "open",
        send: () => {},
        close: () => {},
        onMessage: (listener: (message: EngineRelayMessage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        ready: Promise.resolve(),
      };
    },
  };
}

function createInstance(id: string): AgentInstanceRecord {
  return {
    id,
    environmentId: "env_remote_death",
    ownerUserId: "user_remote_death",
    creationSource: "user",
    name: "default",
    isDefault: true,
    createdByUserId: "user_remote_death",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

let facade: FakeFacade;
let starts: number;
let startedGenerations: number[];

beforeEach(() => {
  initializeAgentRuntimeModuleConfig({});
  facade = createFacade();
  starts = 0;
  startedGenerations = [];
  stubCoreRuntimeFacade(facade);
  bindAgentInstanceRuntimeOperations({
    async spawnInstance(_environmentId, _ownerUserId, _source, options) {
      starts += 1;
      startedGenerations.push(options.runtimeGeneration);
      facade.records.set(options.instanceUid, {
        instanceId: options.instanceUid,
        nodeId: "mach_remote_death",
        status: "running",
        runtimeGeneration: options.runtimeGeneration,
        serverEpoch: options.serverEpoch,
      });
      return {};
    },
    async stopInstance() {},
    hasActiveInstance: () => false,
  });
});

afterEach(() => {
  resetAgentInstanceRuntimeOperations();
  resetCoreRuntimeFacadeStub();
});

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("远端 Agent 死亡后的运行实体回收", () => {
  // 同代死亡先删除 core 记录并复位 Coordinator，下一次 ensure 必须启动新一代而不是复用死快照。
  test("死亡回收后下一次 ensure 启动新 generation", async () => {
    const instance = createInstance("inst_remote_death_001");
    await agentInstanceService.ensureInstanceRuntime(instance);
    const generation = agentInstanceService.getRuntimeSnapshot(instance.id).runtimeGeneration;
    expect(starts).toBe(1);

    terminateRemoteDeadInstance(instance.id, generation);

    expect(facade.records.has(instance.id)).toBe(false);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("stopped");

    await agentInstanceService.ensureInstanceRuntime(instance);
    expect(starts).toBe(2);
    expect(startedGenerations.at(-1)).toBeGreaterThan(generation);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("running");
  });

  // 旧代进程迟到的死亡事件不得删除已重启的新代实体。
  test("旧 generation 的迟到死亡事件被 fence 忽略", async () => {
    const instance = createInstance("inst_remote_death_002");
    await agentInstanceService.ensureInstanceRuntime(instance);
    const oldGeneration = agentInstanceService.getRuntimeSnapshot(instance.id).runtimeGeneration;
    terminateRemoteDeadInstance(instance.id, oldGeneration);
    await agentInstanceService.ensureInstanceRuntime(instance);

    terminateRemoteDeadInstance(instance.id, oldGeneration);

    expect(facade.records.has(instance.id)).toBe(true);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("running");
    expect(starts).toBe(2);
  });

  // local-default 的死亡由 relay_closed 路径处理，远端回收不得重复清理本地实例。
  test("本地实例不参与远端死亡回收", async () => {
    const instance = createInstance("inst_remote_death_003");
    await agentInstanceService.ensureInstanceRuntime(instance);
    const snapshot = facade.records.get(instance.id);
    expect(snapshot).toBeDefined();
    facade.records.set(instance.id, {
      ...(snapshot as Snapshot),
      nodeId: "local-default",
    });
    const generation = agentInstanceService.getRuntimeSnapshot(instance.id).runtimeGeneration;

    terminateRemoteDeadInstance(instance.id, generation);

    expect(facade.records.has(instance.id)).toBe(true);
    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("running");
  });

  // connected:false 帧必须经真实 relay 监听触发回收：只靠机器侧清理无法让 ensure 启动新进程。
  test("relay 收到 connected:false 后按 generation 回收运行实体", async () => {
    const instance = createInstance("inst_remote_death_004");
    await agentInstanceService.ensureInstanceRuntime(instance);
    const generation = agentInstanceService.getRuntimeSnapshot(instance.id).runtimeGeneration;
    globalInstanceRegistry.register(instance.id, {
      userId: instance.ownerUserId,
      organizationId: "org_remote_death",
      environmentId: instance.environmentId,
      spawnSource: "interactive",
      lastActivityAt: Date.now(),
      relayCount: 0,
      lastRelayDetachedAt: null,
    });

    const handle = await connectAgentRelay(instance.id, "rcs_remote_death");
    for (const listener of facade.listeners) {
      listener({ type: "status", payload: { connected: false, agentPid: 4242, runtimeGeneration: generation } });
    }
    await waitFor(() => facade.records.has(instance.id) === false, "死亡回收");

    expect(agentInstanceService.getRuntimeSnapshot(instance.id).state).toBe("stopped");
    expect(globalInstanceRegistry.get(instance.id)).toBeUndefined();
    await handle.close();
  });
});
