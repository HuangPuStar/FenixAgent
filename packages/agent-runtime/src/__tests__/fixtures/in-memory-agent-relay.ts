import { createCoreRuntime } from "@fenix/core";
import type {
  AgentLaunchSpec,
  EnginePlugin,
  EngineRelayHandle,
  EngineRelayMessage,
  EngineRuntime,
} from "@fenix/plugin-sdk";

/** Real Core relay leases over an observable in-memory physical transport. */
export async function createInMemoryAgentRelay(
  onSend?: (message: EngineRelayMessage) => void,
  providedPhysical?: EngineRelayHandle,
) {
  const sent: EngineRelayMessage[] = [];
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  let closed = false;
  let connections = 0;
  const physical: EngineRelayHandle = providedPhysical ?? {
    get state() {
      return closed ? "closed" : "open";
    },
    send(message) {
      sent.push(message);
      onSend?.(message);
    },
    close() {
      closed = true;
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const runtime: EngineRuntime = {
    async prepareEnvironment() {},
    async startInstance() {},
    async stopInstance() {},
    async connectRelay() {
      connections++;
      return physical;
    },
  };
  const plugin: EnginePlugin = {
    meta: { id: "memory", displayName: "Memory", version: "1" },
    createRuntime: () => runtime,
  };
  const core = createCoreRuntime({
    plugins: [plugin],
    nodes: [{ id: "memory", mode: "local", status: "online", engineTypes: ["memory"] }],
  });
  const launchSpec: AgentLaunchSpec = {
    organizationId: "org",
    userId: "user",
    environmentId: "env",
    env: {},
    agent: { name: "Memory", prompt: "test" },
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
  await core.launchInstance({
    instanceId: "relay-boundary",
    engineType: "memory",
    nodeId: "memory",
    launchSpec,
    runtimeGeneration: 1,
    serverEpoch: "test",
  });
  return {
    core,
    sent,
    physical,
    listeners,
    connections: () => connections,
    connect: () => core.connectInstanceRelay({ instanceId: "relay-boundary" }),
    emit(message: unknown) {
      for (const listener of listeners) listener(message as EngineRelayMessage);
    },
  };
}

/** Explicit gates avoid relying on timer ordering for protocol delivery. */
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
