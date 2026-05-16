import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@mothership/plugin-sdk";
import * as coreModule from "../index";
import { createRuntimeInstanceStore } from "../runtime/runtime-instance-store";
import { createFakeEnginePlugin } from "./fixtures/fake-engine-plugin";

function createLaunchSpec(): AgentLaunchSpec {
  return {
    workspace: "/tmp/mothership-core-runtime",
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

describe("createCoreRuntime", () => {
  // 可在创建时预装配 plugins 与 nodes
  test("preloads plugins and nodes through createCoreRuntime options", () => {
    const fakePlugin = createFakeEnginePlugin();
    const runtime = coreModule.createCoreRuntime({
      plugins: [fakePlugin],
      nodes: [
        {
          id: "local-default",
          mode: "local",
          engineTypes: ["fake-engine"],
          status: "online",
        },
      ],
    });

    expect(runtime.listPlugins()).toEqual([fakePlugin]);
    expect(runtime.getPlugin("fake-engine")).toBe(fakePlugin);
    expect(runtime.listNodes()).toEqual([
      {
        id: "local-default",
        mode: "local",
        engineTypes: ["fake-engine"],
        status: "online",
        metadata: undefined,
      },
    ]);
    expect(runtime.getNode("local-default")).toEqual({
      id: "local-default",
      mode: "local",
      engineTypes: ["fake-engine"],
      status: "online",
      metadata: undefined,
    });
  });

  // facade 会把生命周期调用委托给 orchestrator
  test("delegates lifecycle operations through the facade", async () => {
    const runtime = coreModule.createCoreRuntime({
      plugins: [createFakeEnginePlugin()],
      nodes: [
        {
          id: "local-default",
          mode: "local",
          engineTypes: ["fake-engine"],
          status: "online",
        },
      ],
      store: createRuntimeInstanceStore(),
    });

    await runtime.launchInstance({
      instanceId: "inst_core",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });
    expect(runtime.getInstance("inst_core")).toMatchObject({
      status: "running",
      relayConnected: false,
    });

    await runtime.connectInstanceRelay({ instanceId: "inst_core" });
    expect(runtime.listInstances()).toEqual([
      expect.objectContaining({
        instanceId: "inst_core",
        status: "running",
        relayConnected: true,
      }),
    ]);

    await runtime.stopInstance("inst_core");
    expect(runtime.getInstance("inst_core")).toMatchObject({
      status: "stopped",
      relayConnected: false,
    });
  });

  // 公开入口应包含 facade 与测试友好工厂，不暴露 orchestrator 内部实现
  test("exports only the controlled public API", () => {
    expect(coreModule.createCoreRuntime).toBeFunction();
    expect(coreModule.EnginePluginRegistry).toBeFunction();
    expect(coreModule.CoreNodeRegistry).toBeFunction();
    expect(coreModule.createRuntimeInstanceStore).toBeFunction();
    expect("createInstanceOrchestrator" in coreModule).toBe(false);
    expect("RuntimeInstanceRuntimeEntry" in coreModule).toBe(false);
  });

  // getInstance() 返回快照副本，不泄漏 runtime cache 字段也不会污染内部状态
  test("returns isolated instance snapshots without runtime cache internals", async () => {
    const runtime = coreModule.createCoreRuntime({
      plugins: [createFakeEnginePlugin()],
      nodes: [
        {
          id: "local-default",
          mode: "local",
          engineTypes: ["fake-engine"],
          status: "online",
        },
      ],
    });

    await runtime.launchInstance({
      instanceId: "inst_isolated",
      engineType: "fake-engine",
      nodeId: "local-default",
      launchSpec: createLaunchSpec(),
    });

    const snapshot = runtime.getInstance("inst_isolated");
    if (!snapshot) {
      throw new Error("expected instance snapshot");
    }

    expect("runtime" in snapshot).toBe(false);
    const mutableSnapshot = snapshot as typeof snapshot & {
      -readonly [K in keyof typeof snapshot]: (typeof snapshot)[K];
    };
    mutableSnapshot.status = "error";
    mutableSnapshot.launchSpec.workspace = "/tmp/changed";

    expect(runtime.getInstance("inst_isolated")).toMatchObject({
      status: "running",
    });
    expect(runtime.getInstance("inst_isolated")?.launchSpec.workspace).toBe(
      "/tmp/mothership-core-runtime",
    );
  });
});
