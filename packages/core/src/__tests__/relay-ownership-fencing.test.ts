import { expect, test } from "bun:test";
import type { AgentLaunchSpec, EngineRuntime } from "@fenix/plugin-sdk";
import { CoreNodeRegistry } from "../registry/core-node-registry";
import { EnginePluginRegistry } from "../registry/engine-plugin-registry";
import { createInstanceOrchestrator } from "../runtime/instance-orchestrator";
import { createRuntimeInstanceStore } from "../runtime/runtime-instance-store";
import { createFakeEnginePlugin, createFakeRelayHandle } from "./fixtures/fake-engine-plugin";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
const spec: AgentLaunchSpec = {
  organizationId: "org",
  userId: "owner",
  environmentId: "env",
  env: {},
  agent: { name: "test", prompt: "test" },
  model: {
    provider: "test",
    protocol: "openai",
    baseUrl: "https://example.com",
    apiKey: "fixture",
    model: "test",
    modelName: "test",
  },
  skills: [],
  mcpServers: [],
};
function setup() {
  const plugins = new EnginePluginRegistry();
  const nodes = new CoreNodeRegistry();
  const plugin = createFakeEnginePlugin();
  plugins.register(plugin);
  nodes.register({ id: "local", mode: "local", status: "online", engineTypes: ["fake-engine"] });
  const store = createRuntimeInstanceStore();
  const orchestrator = createInstanceOrchestrator({ store, pluginRegistry: plugins, nodeRegistry: nodes });
  return {
    store,
    orchestrator,
    runtime: plugin.createRuntime(),
    launch: {
      instanceId: "instance",
      engineType: "fake-engine",
      nodeId: "local",
      launchSpec: spec,
      runtimeGeneration: 1,
      serverEpoch: "epoch",
    },
  };
}

// 首次并发建连必须共享一个在途连接，单个请求释放不关闭其他请求正在用的物理通道。
test("concurrent first consumers receive independent leases over one tracked connection", async () => {
  const context = setup();
  await context.orchestrator.launch(context.launch);
  const ready = deferred<ReturnType<typeof createFakeRelayHandle>>();
  let connects = 0;
  context.runtime.connectRelay = async () => {
    connects++;
    return ready.promise;
  };
  const first = context.orchestrator.connectRelay({ instanceId: "instance" });
  const second = context.orchestrator.connectRelay({ instanceId: "instance" });
  const physical = createFakeRelayHandle();
  ready.resolve(physical);
  const [a, b] = await Promise.all([first, second]);
  expect(connects).toBe(1);
  expect(a).not.toBe(b);
  await a.close();
  expect(b.state).toBe("open");
  b.send({ type: "still active" });
  expect(physical.sentMessages).toEqual([{ type: "still active" }]);
  await context.orchestrator.stop("instance");
  expect(physical.state).toBe("closed");
  expect(b.state).toBe("closed");
});

// stop 已确认后才完成的建连必须自行关闭，不可重新缓存到 stopped 或下一代实例。
test("late physical relay after stop is reclaimed and cannot mutate the stopped record", async () => {
  const context = setup();
  await context.orchestrator.launch(context.launch);
  const ready = deferred<ReturnType<typeof createFakeRelayHandle>>();
  const entered = deferred<void>();
  context.runtime.connectRelay = async () => {
    entered.resolve();
    return ready.promise;
  };
  const connection = context.orchestrator.connectRelay({ instanceId: "instance" });
  await entered.promise;
  const rejected = connection.then(
    () => null,
    (error: unknown) => error,
  );
  await context.orchestrator.stop("instance");
  const physical = createFakeRelayHandle();
  ready.resolve(physical);
  expect(await rejected).toBeInstanceOf(Error);
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(physical.state).toBe("closed");
  expect(context.store.get("instance")?.status).toBe("stopped");
  expect(context.store.get("instance")?.relayConnected).toBe(false);
});

// 刷新恢复时核对运行身份，不能覆盖停止状态或新一代配置。
test("late refresh cannot commit across stop and same-UID replacement", async () => {
  const context = setup();
  await context.orchestrator.launch(context.launch);
  const ready = deferred<void>();
  const entered = deferred<void>();
  context.runtime.prepareEnvironment = async () => {
    entered.resolve();
    await ready.promise;
  };
  const refreshed = context.orchestrator.refreshEnvironment({
    instanceId: "instance",
    launchSpec: { ...spec, env: { VALUE: "old refresh" } },
  });
  const refreshedResult = refreshed.catch((error: unknown) => error);
  await entered.promise;
  const queued = context.orchestrator.refreshEnvironment({
    instanceId: "instance",
    launchSpec: { ...spec, env: { VALUE: "queued old generation" } },
  });
  const queuedResult = queued.catch((error: unknown) => error);
  await context.orchestrator.stop("instance");
  context.store.delete("instance");
  const replacementSpec = { ...spec, env: { VALUE: "new generation" } };
  context.store.create({ ...context.launch, runtimeGeneration: 2, launchSpec: replacementSpec });
  const replacement: EngineRuntime = { ...context.runtime };
  context.store.attachRuntime("instance", { plugin: null, runtime: replacement, relay: null });
  context.store.update("instance", { status: "running" });
  ready.resolve();
  expect(await refreshedResult).toMatchObject({ code: "INVALID_INSTANCE_STATE" });
  expect(await queuedResult).toMatchObject({ code: "INVALID_INSTANCE_STATE" });
  expect(context.store.get("instance")).toMatchObject({
    status: "running",
    runtimeGeneration: 2,
    launchSpec: replacementSpec,
  });
});

// 物理句柄已创建但 ready 永远不完成时，stop 仍必须关闭句柄并唤醒建连等待。
test("stop reclaims a relay blocked in ready and wakes its waiting consumers", async () => {
  const context = setup();
  await context.orchestrator.launch(context.launch);
  const relay = createFakeRelayHandle();
  relay.ready = new Promise<void>(() => {});
  const entered = deferred<void>();
  context.runtime.connectRelay = async () => {
    entered.resolve();
    return relay;
  };
  const pending = context.orchestrator.connectRelay({ instanceId: "instance" });
  const rejected = pending.then(
    () => null,
    (error: unknown) => error,
  );
  await entered.promise;
  await Promise.resolve();
  await context.orchestrator.stop("instance");
  expect(await rejected).toBeInstanceOf(Error);
  expect(relay.state).toBe("closed");
  expect(context.store.get("instance")?.status).toBe("stopped");
});
