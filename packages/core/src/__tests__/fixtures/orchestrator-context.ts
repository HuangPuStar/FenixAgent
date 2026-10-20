import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { CoreNodeRegistry } from "../../registry/core-node-registry";
import { EnginePluginRegistry } from "../../registry/engine-plugin-registry";
import { createInstanceOrchestrator } from "../../runtime/instance-orchestrator";
import { createRuntimeInstanceStore } from "../../runtime/runtime-instance-store";
import { createFakeEnginePlugin } from "./fake-engine-plugin";

/** Construct a complete launch scope for orchestration regression fixtures. */
export function createLaunchSpec(): AgentLaunchSpec {
  return {
    organizationId: "org",
    userId: "owner",
    environmentId: "env",
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

/** Assemble isolated runtime ownership dependencies for orchestration regressions. */
export function createTestContext(options?: {
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
