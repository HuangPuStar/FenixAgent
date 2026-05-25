import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@mothership/plugin-sdk";
import { CoreNodeRegistry } from "../registry/core-node-registry";
import { EnginePluginRegistry } from "../registry/engine-plugin-registry";
import { createInstanceOrchestrator } from "../runtime/instance-orchestrator";
import { createRuntimeInstanceStore } from "../runtime/runtime-instance-store";
import { createFakeEnginePlugin } from "./fixtures/fake-engine-plugin";

function createLaunchSpec(): AgentLaunchSpec {
  return {
    workspace: "/tmp/mothership-orchestrator",
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
});
