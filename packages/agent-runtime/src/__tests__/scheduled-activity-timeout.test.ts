import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import { createAgentRuntime } from "../runtime";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import {
  bindAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../server/services/agent-instance-service";
import {
  initializeAgentRuntimeModuleConfig,
  resetCoreRuntimeFacadeStub,
  stubAgentRuntimeConfig,
  stubCoreRuntimeFacade,
} from "../server/testing";
import {
  bindRelayLifecyclePort,
  resetRelayLifecyclePort,
  tryGetRelayLifecyclePort,
} from "../server/transport/relay/lifecycle-port";
import {
  listInstanceActivitySnapshots,
  resetAcpIdleMonitorDeps,
  runAcpIdleMonitorSweep,
} from "../services/acp-idle-monitor";
import { acquireAgentExecution, hasActiveAgentExecutions } from "../services/agent-execution-admission";
import { createAgentSession, createPromptTurn } from "../services/agent-prompt-turn";
import { releaseAgentSessionTurns } from "../services/agent-session-admission";
import { globalInstanceRegistry } from "../services/instance-registry";

const disposers: Array<() => void> = [];
let savedRelayPort: ReturnType<typeof tryGetRelayLifecyclePort>;

beforeEach(() => {
  initializeAgentRuntimeModuleConfig();
  stubAgentRuntimeConfig({ scheduledAgentMaxConcurrency: 1, acpIdleTimeoutSeconds: 10, acpActivityTimeoutSeconds: 60 });
  resetAcpIdleMonitorDeps();
  savedRelayPort = tryGetRelayLifecyclePort();
  bindRelayLifecyclePort({
    closeClientsByInstance() {},
    async reclaimInstanceRealtimeResources() {},
    closeAllClients() {},
  });
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  resetAgentInstanceRuntimeOperations();
  resetCoreRuntimeFacadeStub();
  resetAcpIdleMonitorDeps();
  resetRelayLifecyclePort();
  if (savedRelayPort) bindRelayLifecyclePort(savedRelayPort);
  globalInstanceRegistry.clear();
  resetAllStubs();
});

async function setup() {
  const instance: AgentInstanceRecord = {
    id: `inst_${randomUUID().replaceAll("-", "")}`,
    environmentId: "timeout-env",
    ownerUserId: "timeout-owner",
    creationSource: "workflow",
    name: "primary",
    isDefault: false,
    createdByUserId: "timeout-owner",
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  const core = new Map<
    string,
    { instanceId: string; runtimeGeneration: number; serverEpoch: string; status: string; createdAt: Date }
  >();
  const runtime = createAgentRuntime();
  const messages: EngineRelayMessage[] = [];
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  let stops = 0;
  let stopEffect = async () => {};
  stubCoreRuntimeFacade({ getInstance: (id: string) => core.get(id) ?? null, listInstances: () => [...core.values()] });
  bindAgentInstanceRuntimeOperations({
    async spawnInstance(_env, _user, _source, options) {
      core.set(instance.id, {
        instanceId: instance.id,
        runtimeGeneration: options.runtimeGeneration,
        serverEpoch: options.serverEpoch,
        status: "running",
        createdAt: new Date(),
      });
      globalInstanceRegistry.register(instance.id, {
        userId: instance.ownerUserId,
        organizationId: "timeout-org",
        environmentId: instance.environmentId,
        spawnSource: "scheduled",
        lastActivityAt: Date.now() - 61_000,
        relayCount: 1,
        lastRelayDetachedAt: null,
      });
    },
    hasActiveInstance: (id) => core.has(id),
    async stopInstance(id) {
      stops++;
      await stopEffect();
      core.delete(id);
      globalInstanceRegistry.unregister(id);
      for (const listener of [...listeners]) listener({ type: "relay_closed" });
    },
  });
  await runtime.ensureInstanceRuntime(instance);
  const execution = (source: "scheduled" | "interactive", confirmed = true) => {
    const lease = acquireAgentExecution({ userId: instance.ownerUserId, source });
    lease.attach(instance.id);
    if (confirmed) lease.confirmRuntime();
    disposers.push(() => lease.release());
    return lease;
  };
  disposers.push(() => {
    for (const listener of [...listeners]) listener({ type: "relay_closed" });
    releaseAgentSessionTurns(instance.id);
  });
  return {
    instance,
    runtime,
    messages,
    execution,
    stops: () => stops,
    stopEffect: (effect: () => Promise<void>) => {
      stopEffect = effect;
    },
    cancelledTurn: async () => {
      const lease = execution("scheduled");
      const session = createAgentSession({
        instanceId: instance.id,
        relayHandle: {
          state: "open",
          send: (message) => {
            messages.push(message);
          },
          onMessage: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          close() {},
        },
      });
      const turn = createPromptTurn(session, "ses-timeout", undefined, () => lease.release());
      turn.prompt([{ type: "text", text: "run" }]);
      await turn.cancel();
      return turn;
    },
  };
}

function expectScheduledQuotaHeld() {
  expect(() => acquireAgentExecution({ userId: "other-owner", source: "scheduled" })).toThrow();
}

// 未确认取消的定时执行保留额度，只有硬超时真正停止 runtime 后才归还，随后同持久实例仍可 ensure。
test("hard activity timeout stops a hung cancelled scheduled turn before releasing quota", async () => {
  const context = await setup();
  await context.cancelledTurn();
  expect(context.messages).toHaveLength(2);
  expectScheduledQuotaHeld();
  expect(listInstanceActivitySnapshots()[0]).toMatchObject({
    idle_kill_eligible: false,
    activity_kill_eligible: true,
  });
  let confirmStop = () => {};
  const stopGate = new Promise<void>((resolve) => {
    confirmStop = resolve;
  });
  context.stopEffect(() => stopGate);
  const sweep = runAcpIdleMonitorSweep();
  for (let attempts = 0; context.stops() === 0 && attempts < 50; attempts++) await Bun.sleep(1);
  expect(context.stops()).toBe(1);
  expectScheduledQuotaHeld();
  expect(hasActiveAgentExecutions(context.instance.id)).toBe(true);
  confirmStop();
  await sweep;
  expect(hasActiveAgentExecutions(context.instance.id)).toBe(false);
  const next = acquireAgentExecution({ userId: "other-owner", source: "scheduled" });
  next.release();
  await context.runtime.ensureInstanceRuntime(context.instance);
  expect(context.runtime.getRuntimeSnapshot(context.instance.id)).toMatchObject({
    state: "running",
    runtimeGeneration: 2,
  });
});

// 空闲期限短于硬期限时，活跃定时执行不能被普通 idle 或默认公共回收入口打断。
test("idle reclamation protects a live scheduled execution", async () => {
  const context = await setup();
  context.execution("scheduled");
  const supplement = globalInstanceRegistry.get(context.instance.id)!;
  supplement.lastActivityAt = Date.now() - 11_000;
  supplement.relayCount = 0;
  expect(await context.runtime.reclaimInstance(context.instance.id, "timeout-org", 1)).toMatchObject({ ok: false });
  expect(
    await context.runtime.reclaimInstance(context.instance.id, "timeout-org", 1, "activity-timeout"),
  ).toMatchObject({
    ok: false,
  });
  await runAcpIdleMonitorSweep();
  expect(context.stops()).toBe(0);
  expectScheduledQuotaHeld();
});

// 实际执行来源优先于首次启动来源，定时启动的共享 runtime 上存在交互执行时也不能被硬超时停止。
test("hard timeout preserves interactive executions on a scheduled runtime", async () => {
  const context = await setup();
  context.execution("scheduled");
  context.execution("interactive");
  expect(listInstanceActivitySnapshots()[0]?.activity_kill_eligible).toBe(false);
  await runAcpIdleMonitorSweep();
  expect(
    await context.runtime.reclaimInstance(context.instance.id, "timeout-org", 1, "activity-timeout"),
  ).toMatchObject({
    ok: false,
  });
  expect(context.stops()).toBe(0);
  expectScheduledQuotaHeld();
});

// 捕获旧代次的超时不能停止新 runtime，也不能释放新执行的 scheduled 配额。
test("late hard timeout cannot reclaim a replacement generation", async () => {
  const context = await setup();
  await context.runtime.restartInstanceRuntime(context.instance);
  context.execution("scheduled");
  expect(
    await context.runtime.reclaimInstance(context.instance.id, "timeout-org", 1, "activity-timeout"),
  ).toMatchObject({
    ok: false,
    error: "Runtime changed",
  });
  expect(context.stops()).toBe(1);
  expectScheduledQuotaHeld();
  expect(context.runtime.getRuntimeSnapshot(context.instance.id)).toMatchObject({
    state: "running",
    runtimeGeneration: 2,
  });
});

// 停止失败意味着任务仍可能运行，未知状态下必须继续占用额度，重试确认终止后才释放。
test("failed hard timeout stop retains execution quota until a confirmed retry", async () => {
  const context = await setup();
  await context.cancelledTurn();
  context.stopEffect(async () => {
    throw new Error("runtime stop failed");
  });
  await runAcpIdleMonitorSweep();
  expect(context.stops()).toBe(1);
  expectScheduledQuotaHeld();
  expect(context.runtime.getRuntimeSnapshot(context.instance.id).state).toBe("unknown");
  context.stopEffect(async () => {});
  await runAcpIdleMonitorSweep();
  expect(context.stops()).toBe(2);
  expect(hasActiveAgentExecutions(context.instance.id)).toBe(false);
  const next = acquireAgentExecution({ userId: "other-owner", source: "scheduled" });
  next.release();
});

// 新绑定但还在等待 ensure 的执行不能因旧实体超时而被抢停或丢失额度。
test("hard timeout respects executions still awaiting runtime confirmation", async () => {
  const context = await setup();
  context.execution("scheduled", false);
  await runAcpIdleMonitorSweep();
  expect(context.stops()).toBe(0);
  expectScheduledQuotaHeld();
});
