import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { CoreNodeRegistry } from "../registry/core-node-registry";
import { EnginePluginRegistry } from "../registry/engine-plugin-registry";
import { createInstanceOrchestrator } from "../runtime/instance-orchestrator";
import { createRuntimeInstanceStore } from "../runtime/runtime-instance-store";
import { createFakeEnginePlugin } from "./fixtures/fake-engine-plugin";

function createLaunchSpec(): AgentLaunchSpec {
  return {
    workspace: "/tmp/fenix-orchestrator",
    env: { OPENAI_API_KEY: "sk-test" },
    agent: { name: "writer", prompt: "Be precise" },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4.1",
      modelName: "gpt-4.1",
    },
    skills: [],
    mcpServers: [],
  };
}

function createTestContext(options?: {
  pluginOptions?: Parameters<typeof createFakeEnginePlugin>[0];
  nodeStatus?: "online" | "offline";
  nodeEngineTypes?: string[];
}) {
  const pluginRegistry = new EnginePluginRegistry();
  const nodeRegistry = new CoreNodeRegistry();
  const store = createRuntimeInstanceStore();
  const plugin = createFakeEnginePlugin(options?.pluginOptions);
  const engineType = options?.pluginOptions?.engineType ?? "fake-engine";

  pluginRegistry.register(plugin);
  nodeRegistry.register({
    id: "local-default",
    mode: "local",
    engineTypes: options?.nodeEngineTypes ?? [engineType],
    status: options?.nodeStatus ?? "online",
  });

  return {
    plugin,
    store,
    orchestrator: createInstanceOrchestrator({
      pluginRegistry,
      nodeRegistry,
      store,
    }),
  };
}

describe("InstanceOrchestrator", () => {
  // 生命周期成功路径会按固定顺序推进状态与 runtime 调用
  test("runs launch -> connectRelay -> stop successfully", async () => {
    const { orchestrator, plugin, store } = createTestContext();

    const launched = await orchestrator.launch({
      instanceId: "inst_flow",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    expect(launched.status).toBe("running");
    expect(store.get("inst_flow")?.status).toBe("running");
    expect(store.get("inst_flow")?.relayConnected).toBe(false);

    const relay = await orchestrator.connectRelay({ instanceId: "inst_flow" });
    expect(relay).toBe(plugin.runtimeState.relay);
    expect(store.get("inst_flow")?.relayConnected).toBe(true);

    await orchestrator.stop("inst_flow");
    expect(store.get("inst_flow")?.status).toBe("stopped");
    expect(store.get("inst_flow")?.relayConnected).toBe(false);
    expect(plugin.runtimeState.calls).toEqual(["prepare", "start", "connectRelay", "stop"]);
  });

  // launch() 会在前置校验失败时返回稳定错误码
  test("validates duplicate instance, missing plugin, offline node and unsupported engine", async () => {
    const duplicateContext = createTestContext();
    await duplicateContext.orchestrator.launch({
      instanceId: "inst_duplicate",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    await expect(
      duplicateContext.orchestrator.launch({
        instanceId: "inst_duplicate",
        engineType: "fake-engine",
        nodeId: "local-default",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toMatchObject({ code: "INSTANCE_ALREADY_EXISTS" });

    const missingPluginRegistry = new EnginePluginRegistry();
    const missingPluginNodeRegistry = new CoreNodeRegistry();
    const missingPluginStore = createRuntimeInstanceStore();
    missingPluginNodeRegistry.register({
      id: "local-default",
      mode: "local",
      engineTypes: ["missing-engine"],
      status: "online",
    });
    const missingPluginOrchestrator = createInstanceOrchestrator({
      pluginRegistry: missingPluginRegistry,
      nodeRegistry: missingPluginNodeRegistry,
      store: missingPluginStore,
    });
    await expect(
      missingPluginOrchestrator.launch({
        instanceId: "inst_missing_plugin",
        engineType: "missing-engine",
        nodeId: "local-default",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });

    const offlineContext = createTestContext({ nodeStatus: "offline" });
    await expect(
      offlineContext.orchestrator.launch({
        instanceId: "inst_offline",
        engineType: "fake-engine",
        nodeId: "local-default",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toMatchObject({ code: "NODE_OFFLINE" });

    const unsupportedContext = createTestContext({
      nodeEngineTypes: ["other-engine"],
    });
    await expect(
      unsupportedContext.orchestrator.launch({
        instanceId: "inst_unsupported",
        engineType: "fake-engine",
        nodeId: "local-default",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toMatchObject({ code: "ENGINE_NOT_SUPPORTED" });
  });

  // prepare/start 失败后实例会落盘为 error 状态
  test("persists error state when launch fails during prepare or start", async () => {
    const prepareContext = createTestContext({
      pluginOptions: {
        failOnPrepare: new Error("prepare failed"),
      },
    });
    await expect(
      prepareContext.orchestrator.launch({
        instanceId: "inst_prepare_error",
        engineType: "fake-engine",
        nodeId: "local-default",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toThrow("prepare failed");
    expect(prepareContext.store.get("inst_prepare_error")).toMatchObject({
      status: "error",
      errorMessage: "prepare failed",
    });

    const startContext = createTestContext({
      pluginOptions: {
        failOnStart: new Error("start failed"),
      },
    });
    await expect(
      startContext.orchestrator.launch({
        instanceId: "inst_start_error",
        engineType: "fake-engine",
        nodeId: "local-default",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toThrow("start failed");
    expect(startContext.store.get("inst_start_error")).toMatchObject({
      status: "error",
      errorMessage: "start failed",
    });
  });

  // relay 只允许 running 态，并会复用已打开的连接
  test("enforces running state for connectRelay and reuses open relays", async () => {
    const notStartedContext = createTestContext();
    await expect(notStartedContext.orchestrator.connectRelay({ instanceId: "inst_missing" })).rejects.toMatchObject({
      code: "INSTANCE_NOT_FOUND",
    });

    const preparedContext = createTestContext();
    preparedContext.store.create({
      instanceId: "inst_prepared",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    preparedContext.store.update("inst_prepared", { status: "prepared" });
    preparedContext.store.attachRuntime("inst_prepared", {
      plugin: preparedContext.plugin,
      runtime: preparedContext.plugin.createRuntime(),
      relay: null,
    });
    await expect(preparedContext.orchestrator.connectRelay({ instanceId: "inst_prepared" })).rejects.toMatchObject({
      code: "INVALID_INSTANCE_STATE",
    });
    expect(preparedContext.store.get("inst_prepared")).toMatchObject({
      status: "error",
    });

    const runningContext = createTestContext();
    await runningContext.orchestrator.launch({
      instanceId: "inst_running",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    const firstRelay = await runningContext.orchestrator.connectRelay({
      instanceId: "inst_running",
    });
    const secondRelay = await runningContext.orchestrator.connectRelay({
      instanceId: "inst_running",
    });

    expect(firstRelay).toBe(secondRelay);
    expect(runningContext.plugin.runtimeState.connectRelayCalls).toBe(1);
  });

  // remote node 通过 runtimeResolver 获取 runtime
  test("uses runtimeResolver for remote nodes", async () => {
    const pluginRegistry = new EnginePluginRegistry();
    const nodeRegistry = new CoreNodeRegistry();
    const store = createRuntimeInstanceStore();

    // 用现有的 fake plugin 的 runtime 作为 remote runtime
    const fakePlugin = createFakeEnginePlugin();
    const remoteRuntime = fakePlugin.createRuntime();

    nodeRegistry.register({
      id: "remote-machine-1",
      mode: "remote",
      engineTypes: ["fake-engine"],
      status: "online",
    });

    const orchestrator = createInstanceOrchestrator({
      pluginRegistry,
      nodeRegistry,
      store,
      runtimeResolver: () => remoteRuntime,
    });

    const launched = await orchestrator.launch({
      instanceId: "inst_remote",
      engineType: "fake-engine",
      nodeId: "remote-machine-1",
      launchSpec: createLaunchSpec(),
    });

    expect(launched.status).toBe("running");
    expect(launched.nodeId).toBe("remote-machine-1");

    // remote node 的 runtime entry 中 plugin 应为 null
    const runtimeEntry = store.getRuntimeEntry("inst_remote");
    expect(runtimeEntry?.plugin).toBeNull();
    expect(runtimeEntry?.runtime).toBe(remoteRuntime);
  });

  // remote node 没有提供 runtimeResolver 时应该报错
  test("throws when remote node has no runtimeResolver and no plugin", async () => {
    const pluginRegistry = new EnginePluginRegistry();
    const nodeRegistry = new CoreNodeRegistry();
    const store = createRuntimeInstanceStore();

    nodeRegistry.register({
      id: "remote-machine-2",
      mode: "remote",
      engineTypes: ["fake-engine"],
      status: "online",
    });

    const orchestrator = createInstanceOrchestrator({
      pluginRegistry,
      nodeRegistry,
      store,
    });

    await expect(
      orchestrator.launch({
        instanceId: "inst_remote_no_resolver",
        engineType: "fake-engine",
        nodeId: "remote-machine-2",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toMatchObject({ code: "PLUGIN_NOT_FOUND" });
  });

  // relay/stop 失败时状态会被统一收敛到 error
  test("persists error state for relay and stop failures, and keeps stop idempotent", async () => {
    const relayErrorContext = createTestContext({
      pluginOptions: {
        failOnConnectRelay: new Error("relay failed"),
      },
    });
    await relayErrorContext.orchestrator.launch({
      instanceId: "inst_relay_error",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    await expect(
      relayErrorContext.orchestrator.connectRelay({
        instanceId: "inst_relay_error",
      }),
    ).rejects.toThrow("relay failed");
    expect(relayErrorContext.store.get("inst_relay_error")).toMatchObject({
      status: "error",
      errorMessage: "relay failed",
    });

    const stoppedContext = createTestContext();
    await stoppedContext.orchestrator.launch({
      instanceId: "inst_stopped",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    await stoppedContext.orchestrator.stop("inst_stopped");
    await stoppedContext.orchestrator.stop("inst_stopped");
    expect(stoppedContext.plugin.runtimeState.calls.filter((call) => call === "stop")).toHaveLength(1);

    await expect(stoppedContext.orchestrator.stop("missing-instance")).rejects.toMatchObject({
      code: "INSTANCE_NOT_FOUND",
    });

    const stopErrorContext = createTestContext({
      pluginOptions: {
        failOnStop: new Error("stop failed"),
      },
    });
    await stopErrorContext.orchestrator.launch({
      instanceId: "inst_stop_error",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    await expect(stopErrorContext.orchestrator.stop("inst_stop_error")).rejects.toThrow("stop failed");
    expect(stopErrorContext.store.get("inst_stop_error")).toMatchObject({
      status: "error",
      errorMessage: "stop failed",
    });
  });

  // remote 执行时不传 engineType，通过 runtimeResolver 启动
  test("remote node launches without engineType via runtimeResolver", async () => {
    const pluginRegistry = new EnginePluginRegistry();
    const nodeRegistry = new CoreNodeRegistry();
    const store = createRuntimeInstanceStore();

    const fakePlugin = createFakeEnginePlugin();
    const remoteRuntime = fakePlugin.createRuntime();

    nodeRegistry.register({
      id: "remote-machine-3",
      mode: "remote",
      engineTypes: ["opencode"],
      status: "online",
    });

    const orchestrator = createInstanceOrchestrator({
      pluginRegistry,
      nodeRegistry,
      store,
      runtimeResolver: () => remoteRuntime,
    });

    // 不传 engineType
    const launched = await orchestrator.launch({
      instanceId: "inst_remote_no_engine",
      nodeId: "remote-machine-3",
      launchSpec: createLaunchSpec(),
    });

    expect(launched.status).toBe("running");
    expect(launched.nodeId).toBe("remote-machine-3");
    // engineType 记录为 "remote" 占位值
    expect(launched.engineType).toBe("remote");

    // remote node 的 runtime entry 中 plugin 应为 null
    const runtimeEntry = store.getRuntimeEntry("inst_remote_no_engine");
    expect(runtimeEntry?.plugin).toBeNull();
    expect(runtimeEntry?.runtime).toBe(remoteRuntime);
  });

  // local 执行不传 engineType 时从 node.engineTypes[0] 自动取
  test("local node auto-selects engineType from node declaration", async () => {
    const { orchestrator, store } = createTestContext({
      pluginOptions: { engineType: "ccb" },
      nodeEngineTypes: ["ccb"],
    });

    // 不传 engineType
    const launched = await orchestrator.launch({
      instanceId: "inst_local_auto_engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });

    expect(launched.status).toBe("running");
    expect(launched.engineType).toBe("ccb");
  });

  // local 执行不传 engineType 且 node engineTypes 为空时抛错
  test("throws NO_ENGINE_AVAILABLE when local node has empty engineTypes and no engineType passed", async () => {
    const { orchestrator } = createTestContext({
      nodeEngineTypes: [],
    });

    await expect(
      orchestrator.launch({
        instanceId: "inst_no_engine",
        nodeId: "local-default",
        launchSpec: createLaunchSpec(),
      }),
    ).rejects.toMatchObject({ code: "NO_ENGINE_AVAILABLE" });
  });
});
