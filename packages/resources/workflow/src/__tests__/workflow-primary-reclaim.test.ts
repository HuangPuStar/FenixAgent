import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentInstanceRecord,
  acquireAgentExecution,
  createAgentRuntime,
  type EnvironmentRecord,
  getBoundAgentRuntime,
  type PromptTurn,
} from "@fenix/agent-runtime/runtime";
import {
  bindAgentInstanceRuntimeOperations,
  globalInstanceRegistry,
  resetAgentInstanceRuntimeOperations,
  resetAgentRuntimePort,
  stubAgentRuntimePort,
} from "@fenix/agent-runtime/server/testing";
import type { CoreRuntimeFacade } from "@fenix/core";
import { cleanupSpawnedInstances } from "../server/services/workflow";
import { createAgentChatTransport } from "../server/services/workflow/agent-chat-transport";
import { clearInstanceLeases } from "../server/services/workflow/instance-lease";
import { bindStubCoreRuntime, restoreCoreRuntimePort } from "./core-runtime-stub";

const now = new Date();
const environment: EnvironmentRecord = {
  id: "reclaim-env",
  name: "agent",
  userId: "owner",
  organizationId: "org",
  description: null,
  workspacePath: "unused",
  agentConfigId: null,
  secret: "",
  machineName: null,
  directory: null,
  branch: null,
  gitRepoUrl: null,
  workerType: "acp",
  capabilities: null,
  status: "active",
  username: null,
  autoStart: true,
  lastPollAt: null,
  createdAt: now,
  updatedAt: now,
};
function setup() {
  const instance: AgentInstanceRecord = {
    id: `inst_${randomUUID().replaceAll("-", "")}`,
    environmentId: environment.id,
    ownerUserId: "owner",
    creationSource: "workflow",
    name: "primary",
    isDefault: false,
    createdByUserId: "owner",
    createdAt: now,
    updatedAt: now,
  };
  const core = new Map<
    string,
    { instanceId: string; runtimeGeneration: number; serverEpoch: string; status: string }
  >();
  const facade = {
    getInstance: (id: string) => core.get(id) ?? null,
    listInstances: () => [...core.values()],
  } as unknown as CoreRuntimeFacade;
  bindStubCoreRuntime(facade);
  let starts = 0;
  let stops = 0;
  bindAgentInstanceRuntimeOperations({
    async spawnInstance(_env, _owner, _source, options) {
      starts++;
      core.set(instance.id, {
        instanceId: instance.id,
        runtimeGeneration: options.runtimeGeneration,
        serverEpoch: options.serverEpoch,
        status: "running",
      });
      globalInstanceRegistry.register(instance.id, {
        userId: "owner",
        organizationId: "org",
        environmentId: environment.id,
        spawnSource: "scheduled",
        lastActivityAt: Date.now(),
        relayCount: 0,
        lastRelayDetachedAt: null,
      });
    },
    hasActiveInstance: (id) => core.has(id),
    async stopInstance(id) {
      stops++;
      core.delete(id);
      globalInstanceRegistry.unregister(id);
    },
  });
  const runtime = createAgentRuntime();
  let persisted = false;
  stubAgentRuntimePort({
    observe: {
      ...runtime.observe,
      async listEnvironmentRecordsByOrganization() {
        return [environment];
      },
    },
    async findOrCreateWorkflowInstanceWithStatus() {
      const created = !persisted;
      persisted = true;
      return { instance, created };
    },
    session: {
      ...runtime.session,
      async connectRelay() {
        return { state: "open", send() {}, close() {} };
      },
      async startPromptTurn(options) {
        const turn: PromptTurn = {
          prompt() {
            options.onExecutionFinished?.();
          },
          async *events() {
            yield { type: "event", payload: { jsonrpc: "2.0", id: 1, result: { stopReason: "end_turn" } } };
          },
          async cancel() {},
          release() {},
          async dispose() {},
        };
        return { turn, session: options.session };
      },
    },
  });
  return {
    instance,
    runtime: getBoundAgentRuntime(),
    transport: createAgentChatTransport("org"),
    counts: () => ({ starts, stops }),
  };
}
async function finish(session: Awaited<ReturnType<ReturnType<typeof createAgentChatTransport>["connect"]>>) {
  expect((await session.execute({ prompt: "run" })).exit_code).toBe(0);
  await session.dispose?.();
}
afterEach(() => {
  clearInstanceLeases();
  globalInstanceRegistry.clear();
  resetAgentInstanceRuntimeOperations();
  resetAgentRuntimePort();
  restoreCoreRuntimePort();
});

// 首次新建必须真实经过公共回收与 Coordinator，第二次复用持久 ID 仍可自动启动。
test("workflow primary is reusable after the creator's automatic cleanup", async () => {
  const context = setup();
  const spawned = new Set<string>();
  await finish(await context.transport.connect("agent", { userId: "owner", spawnedInstanceIds: spawned }));
  expect(spawned).toEqual(new Set([context.instance.id]));
  expect(await cleanupSpawnedInstances(spawned, "org")).toEqual([]);
  expect(context.runtime.getRuntimeSnapshot(context.instance.id).state).toBe("stopped");
  const second = new Set<string>();
  await finish(await context.transport.connect("agent", { userId: "owner", spawnedInstanceIds: second }));
  expect(second.size).toBe(0);
  expect(context.runtime.getRuntimeSnapshot(context.instance.id)).toMatchObject({
    state: "running",
    runtimeGeneration: 2,
  });
  expect(context.counts()).toEqual({ starts: 2, stops: 1 });
});

// 用户停止意图不能由自动 cleanup 清除，下一次工作流必须等待用户显式 restart。
test("automatic cleanup cannot bypass a user's explicit stop", async () => {
  const context = setup();
  const spawned = new Set<string>();
  await finish(await context.transport.connect("agent", { userId: "owner", spawnedInstanceIds: spawned }));
  await context.runtime.stopInstanceRuntime(context.instance);
  await cleanupSpawnedInstances(spawned, "org");
  await expect(context.transport.connect("agent", { userId: "owner" })).rejects.toMatchObject({
    code: "INSTANCE_STOPPED",
  });
  expect(context.counts().starts).toBe(1);
});

// 创建者先结束时另一 run 的连接租约与执行准入都继续保护共享 runtime。
test("creator cleanup preserves a concurrent workflow run", async () => {
  const context = setup();
  const spawned = new Set<string>();
  const creator = await context.transport.connect("agent", { userId: "owner", spawnedInstanceIds: spawned });
  const consumer = await context.transport.connect("agent", { userId: "owner" });
  await finish(creator);
  expect(await cleanupSpawnedInstances(spawned, "org")).toEqual([context.instance.id]);
  expect(context.counts().stops).toBe(0);
  await finish(consumer);
});

// 旧 run 收尾只能回收自己捕获的代次，显式重启后的新实体不可被旧清理停止。
test("late creator cleanup cannot reclaim a replacement generation", async () => {
  const context = setup();
  const spawned = new Set<string>();
  await finish(await context.transport.connect("agent", { userId: "owner", spawnedInstanceIds: spawned }));
  await context.runtime.restartInstanceRuntime(context.instance);
  expect(await cleanupSpawnedInstances(spawned, "org")).toEqual([context.instance.id]);
  expect(context.runtime.getRuntimeSnapshot(context.instance.id)).toMatchObject({
    state: "running",
    runtimeGeneration: 2,
  });
  expect(context.counts()).toEqual({ starts: 2, stops: 1 });
});

// 无 Workflow 租约的其他来源执行仍有保护权，不能只按创建来源推断实例可回收。
test("automatic workflow cleanup respects another source's execution admission", async () => {
  const context = setup();
  const spawned = new Set<string>();
  await finish(await context.transport.connect("agent", { userId: "owner", spawnedInstanceIds: spawned }));
  const execution = acquireAgentExecution({ userId: "owner", source: "interactive" });
  try {
    execution.attach(context.instance.id);
    execution.confirmRuntime();
    expect(await cleanupSpawnedInstances(spawned, "org")).toEqual([context.instance.id]);
    expect(context.counts().stops).toBe(0);
  } finally {
    execution.release();
  }
});
