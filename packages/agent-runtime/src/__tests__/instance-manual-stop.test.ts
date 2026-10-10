import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ChatChannelController,
  classifyPermanentSpawnFailure,
  DocManager,
  type WsConnection,
} from "@fenix/chat-channel/server";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createWebInstancesRoutes } from "../routes/web/instances";
import type { AgentInstanceRecord, IAgentInstanceRepo } from "../server/repositories/agent-instance";
import { AgentInstanceRuntimeCoordinator } from "../server/services/agent-instance-runtime-coordinator";
import { AgentInstanceService } from "../server/services/agent-instance-service";
import { resetAgentRuntimePort, stubAgentRuntimePort } from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const instance: AgentInstanceRecord = {
  id: "inst_00000000000000000000000000000002",
  environmentId: "env-1",
  ownerUserId: "user-1",
  creationSource: "user",
  name: "default",
  isDefault: true,
  createdByUserId: "user-1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const repository = {
  findOwnedById: async (id: string, owner: string) =>
    id === instance.id && owner === instance.ownerUserId ? instance : undefined,
  listByEnvironment: async () => [instance],
} as unknown as IAgentInstanceRepo;

const routes = createWebInstancesRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin() });
const action = (name: "stop" | "restart") =>
  routes.handle(new Request(`http://localhost/instances/${instance.id}/${name}`, { method: "POST" }));

/** 无网络 WebSocket，关闭时执行真实 Gateway 清理，避免定时器与共享 relay 泄漏。 */
function createSocket(onClose: () => void) {
  const closed: Array<number | undefined> = [];
  const ws: WsConnection = {
    readyState: 1,
    send() {},
    close(code) {
      closed.push(code);
      onClose();
    },
  };
  return { ws, closed };
}

describe("AOS-BUG-002 主动停止", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({ organizationId: "org-1", userId: instance.ownerUserId });
  });
  afterEach(() => {
    resetAgentRuntimePort();
    resetTestAuth();
    resetAllStubs();
  });

  for (const hasHistory of [false, true]) {
    for (const pageOpen of [false, true]) {
      // 四种页面/历史组合均需阻止后台 ensure；显式 restart 后才允许聊天连接恢复。
      test(`历史会话=${hasHistory}，聊天页打开=${pageOpen}：stop 后重连与回读不启动`, async () => {
        let starts = 0;
        const active = new Set<string>();
        const docs = new DocManager();
        const coordinator = new AgentInstanceRuntimeCoordinator({
          async start(record) {
            starts += 1;
            active.add(record.id);
          },
          async stop(id) {
            active.delete(id);
            chat.registry.closeClientsByInstance(id, 4002, "instance_stopped");
            await chat.relayEvents.reclaimInstanceRealtimeResources(id);
          },
        });
        const service = new AgentInstanceService(repository, coordinator);
        const chat = new ChatChannelController({
          docManager: docs,
          getEnvironment: async () => ({ userId: instance.ownerUserId, organizationId: "org-1" }),
          authorizeEnvironment: (userId, env) => env.userId === userId,
          resolveWorkspacePath: () => "/workspace",
          // 对齐 chat-channel-bootstrap 的授权后解析与 ensure 链路，使用真实领域服务而非启动桩。
          ensureRunning: async (ownerUserId, environmentId, requestedInstanceUid) => {
            const record = await service.resolveInstanceForOperation({
              ownerUserId,
              environmentId,
              requestedInstanceUid,
              automaticSelection: "chat",
            });
            await service.ensureInstanceRuntime(record);
            return record.id;
          },
          connectAgentRelay: async () => ({ state: "open", send() {}, close() {} }),
          refreshInstanceEnvironment: async () => {},
          markRelayAttached() {},
          markRelayDetached() {},
          touchInstanceActivity() {},
          terminateLocalDeadInstance() {},
          isMachineOffline: () => false,
          classifyPermanentSpawnFailure,
          maxClients: () => 10,
          snapshotPersist: () => ({ intervalMs: 2000, idleMs: 500, ttlSeconds: 604800 }),
          log() {},
          reportError() {},
        });
        stubAgentRuntimePort({
          getOwnedInstance: service.getOwnedInstance.bind(service),
          getOwnedEnvironment: async () => ({ id: instance.environmentId }) as never,
          stopInstanceRuntime: service.stopInstanceRuntime.bind(service),
          restartInstanceRuntime: service.restartInstanceRuntime.bind(service),
        });
        const locator = { instanceUid: instance.id, rcsSessionId: "rcs-manual-stop" };
        const open = async (id: string) => {
          const socket = createSocket(() => chat.gateway.handleClose(id));
          await chat.gateway.handleOpen(socket.ws, id, instance.ownerUserId, instance.environmentId, locator);
          return socket;
        };
        try {
          await service.ensureInstanceRuntime(instance);
          if (hasHistory) {
            await docs.openChat(locator.rcsSessionId);
            await docs.openSession(instance.ownerUserId, instance.environmentId, locator.rcsSessionId);
            docs.processNormalizedEvent(locator.rcsSessionId, {
              type: "session_updated",
              update: { sessionId: "ses-history", status: "ready" },
              content: null,
            });
          }
          const original = await open("before-stop");
          expect(chat.registry.getClient("before-stop")?.acpSessionId).toBe(hasHistory ? "ses-history" : null);
          if (!pageOpen) chat.gateway.handleClose("before-stop");
          const response = await action("stop");
          expect(response.status).toBe(200);
          expect(await response.json()).toEqual({ success: true, data: null });
          expect(original.closed).toEqual(pageOpen ? [4002] : []);

          // 重放多个轮询/自动 ensure 周期；无需依赖真实时间或外部 Agent 进程。
          for (let cycle = 0; cycle < 3; cycle += 1) {
            expect(service.getRuntimeSnapshot(instance.id).state).toBe("stopped");
            await expect(service.ensureInstanceRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
            expect(await service.restartActiveInstancesForEnvironments([instance.environmentId])).toEqual([]);
          }
          const reconnect = await open("after-stop");
          expect(reconnect.closed).toEqual([4502]);
          expect(chat.registry.getClient("after-stop")).toBeUndefined();
          expect(active.size).toBe(0);
          expect(starts).toBe(1);
          expect(service.getRuntimeSnapshot(instance.id).state).toBe("stopped");

          expect((await action("restart")).status).toBe(200);
          expect((await open("after-restart")).closed).toEqual([]);
          expect(service.getRuntimeSnapshot(instance.id).state).toBe("running");
          expect(active.has(instance.id)).toBe(true);
          expect(starts).toBe(2);
        } finally {
          chat.registry.closeClientsByInstance(instance.id, 1000, "test cleanup");
          await coordinator.shutdown();
          await docs.closeAll();
        }
      });
    }
  }

  // 显式 restart 的启动失败不能把用户停止意图变成允许后台重试。
  test("restart 失败后仍禁止 ensure，显式重试成功才恢复", async () => {
    let failStart = false;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start() {
        if (failStart) throw new Error("start failed");
      },
      async stop() {},
    });
    await coordinator.ensureRuntime(instance);
    await coordinator.stopRuntime(instance, "strict");
    failStart = true;
    await expect(coordinator.restartRuntime(instance)).rejects.toThrow("start failed");
    await expect(coordinator.ensureRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
    failStart = false;
    await coordinator.restartRuntime(instance);
    await coordinator.ensureRuntime(instance);
    expect(coordinator.snapshot(instance.id).state).toBe("running");
  });

  // 被 stop 抢占的迟到启动必须按世代补偿，且不得解除停止意图或污染其他实例。
  test("stop 抢占 restart 时迟到启动被回收，停止意图按实例隔离", async () => {
    let releaseStart: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseStart = resolve;
    });
    const active = new Map<string, number>();
    let delay = false;
    const coordinator = new AgentInstanceRuntimeCoordinator({
      async start(record, generation) {
        if (delay) await gate;
        active.set(record.id, generation);
      },
      async stop(id, generation) {
        if (active.get(id) === generation) active.delete(id);
      },
    });
    await coordinator.ensureRuntime(instance);
    await coordinator.stopRuntime(instance, "strict");
    delay = true;
    const restarting = coordinator.restartRuntime(instance);
    await coordinator.stopRuntime(instance, "strict");
    releaseStart?.();
    await restarting;
    expect(active.size).toBe(0);
    await expect(coordinator.ensureRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
    await coordinator.ensureRuntime({ ...instance, id: "inst_00000000000000000000000000000003" });
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
    expect(active.size).toBe(1);
  });

  // 机器 clean-slate 与迟到死亡通知只修正运行事实，不能抹除主动停止意图。
  test("机器重新连接后仍保持主动停止", async () => {
    const coordinator = new AgentInstanceRuntimeCoordinator({ async start() {}, async stop() {} });
    await coordinator.ensureRuntime(instance);
    await coordinator.stopRuntime(instance, "strict");
    const generation = coordinator.snapshot(instance.id).runtimeGeneration;
    coordinator.handleRuntimeDisconnect(instance.id, generation, "machine-1");
    coordinator.handleMachineCleanSlate("machine-1");
    coordinator.handleRuntimeDeath(instance.id, generation);
    await expect(coordinator.ensureRuntime(instance)).rejects.toMatchObject({ code: "INSTANCE_STOPPED" });
    expect(coordinator.snapshot(instance.id).state).toBe("stopped");
  });
});
