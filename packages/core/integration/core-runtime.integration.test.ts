/**
 * 默认关闭的真实链路验证入口，用于手动确认 core facade 没有破坏 opencode plugin 集成链路。
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createEnginePlugin } from "@mothership/opencode";
import type { AgentLaunchSpec, EngineRelayHandle, EngineRelayMessage } from "@mothership/plugin-sdk";
import { createCoreRuntime } from "../src/index";

interface IntegrationRelayConfig {
  requestMessages: Record<string, unknown>[];
  successMatch: {
    type?: string;
    sessionUpdate?: string;
    rawIncludes?: string;
  };
}

interface IntegrationTestConfig {
  enabled: boolean;
  instanceId?: string;
  nodeId?: string;
  engineType: string;
  launchTimeoutMs?: number;
  relayReadyDelayMs?: number;
  responseTimeoutMs?: number;
  launchSpec: AgentLaunchSpec;
  relay: IntegrationRelayConfig;
}

interface ObservableRelayHandle extends EngineRelayHandle {
  onMessage(listener: (message: EngineRelayMessage) => void): () => void;
}

const CONFIG_PATHS = [
  `${import.meta.dirname}/core-runtime.local.json`,
  `${import.meta.dirname}/core-runtime.conf.json`,
] as const;
const LOG_PREFIX = "[core-runtime integration]";

function logStep(label: string, detail?: unknown): void {
  if (detail === undefined) {
    console.log(`${LOG_PREFIX} ${label}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${label}`, detail);
}

function loadIntegrationConfig(): IntegrationTestConfig | null {
  const configPath = CONFIG_PATHS.find((candidate) => existsSync(candidate));
  if (!configPath) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<IntegrationTestConfig>;
  if (parsed.enabled !== true) {
    return null;
  }

  if (!parsed.launchSpec?.workspace) {
    throw new Error(`Integration config is missing launchSpec.workspace: ${configPath}`);
  }
  if (!parsed.relay?.requestMessages?.length) {
    throw new Error(`Integration config is missing relay.requestMessages: ${configPath}`);
  }
  if (!parsed.engineType) {
    throw new Error(`Integration config is missing engineType: ${configPath}`);
  }

  return {
    enabled: true,
    instanceId: parsed.instanceId ?? `inst_core_integration_${Date.now()}`,
    nodeId: parsed.nodeId ?? "local-default",
    engineType: parsed.engineType,
    launchTimeoutMs: parsed.launchTimeoutMs ?? 30_000,
    relayReadyDelayMs: parsed.relayReadyDelayMs ?? 1_000,
    responseTimeoutMs: parsed.responseTimeoutMs ?? 120_000,
    launchSpec: parsed.launchSpec,
    relay: parsed.relay,
  };
}

function requireObservableRelay(handle: EngineRelayHandle): ObservableRelayHandle {
  if (typeof (handle as Partial<ObservableRelayHandle>).onMessage !== "function") {
    throw new Error("Runtime relay handle does not expose onMessage(listener)");
  }
  return handle as ObservableRelayHandle;
}

function buildLaunchSpec(config: IntegrationTestConfig): AgentLaunchSpec {
  return {
    workspace: config.launchSpec.workspace,
    env: config.launchSpec.env ? { ...config.launchSpec.env } : undefined,
    agent: { ...config.launchSpec.agent },
    model: { ...config.launchSpec.model },
    skills: config.launchSpec.skills.map((skill) => ({ ...skill })),
    mcpServers: config.launchSpec.mcpServers.map((server) => ({ ...server })),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runStep<T>(label: string, operation: () => Promise<T>): Promise<T> {
  logStep(`${label}:start`);
  try {
    const result = await operation();
    logStep(`${label}:ok`);
    return result;
  } catch (error) {
    logStep(`${label}:error`, error);
    throw error;
  }
}

function matchesExpectedResponse(
  message: EngineRelayMessage,
  successMatch: IntegrationRelayConfig["successMatch"],
): boolean {
  if (successMatch.type && message.type !== successMatch.type) {
    return false;
  }

  if (successMatch.sessionUpdate) {
    const sessionUpdate =
      typeof message.payload === "object" && message.payload && "update" in message.payload
        ? (message.payload as { update?: { sessionUpdate?: unknown } }).update?.sessionUpdate
        : undefined;
    if (sessionUpdate !== successMatch.sessionUpdate) {
      return false;
    }
  }

  if (successMatch.rawIncludes) {
    return JSON.stringify(message).includes(successMatch.rawIncludes);
  }

  return true;
}

async function waitForExpectedResponse(
  relay: ObservableRelayHandle,
  successMatch: IntegrationRelayConfig["successMatch"],
  timeoutMs: number,
): Promise<EngineRelayMessage> {
  let lastMessage: EngineRelayMessage | null = null;

  return await new Promise<EngineRelayMessage>((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      logStep("waitForExpectedResponse:timeout", {
        successMatch,
        lastMessage,
      });
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for relay response`));
    }, timeoutMs);

    const unsubscribe = relay.onMessage((message) => {
      lastMessage = message;
      if (!matchesExpectedResponse(message, successMatch)) {
        return;
      }
      clearTimeout(timer);
      unsubscribe();
      resolve(message);
    });
  });
}

async function sendRequestMessagesInOrder(
  relay: ObservableRelayHandle,
  requestMessages: Record<string, unknown>[],
  responseTimeoutMs: number,
): Promise<void> {
  const normalizedMessages = [...requestMessages];
  if (normalizedMessages[0]?.type !== "connect") {
    normalizedMessages.unshift({ type: "connect" });
  }

  for (const message of normalizedMessages) {
    const relayMessage = message as unknown as EngineRelayMessage;
    logStep("sendMessage", relayMessage);
    await relay.send(relayMessage);

    if (relayMessage.type === "connect") {
      await runStep("waitForConnectedStatus", () =>
        waitForExpectedResponse(relay, { type: "status", rawIncludes: '"connected":true' }, responseTimeoutMs),
      );
    }

    if (relayMessage.type === "new_session") {
      await runStep("waitForSessionCreated", () =>
        waitForExpectedResponse(relay, { type: "session_created" }, responseTimeoutMs),
      );
    }
  }
}

const integrationConfig = loadIntegrationConfig();
const integrationTest = integrationConfig ? test : test.skip;
const INTEGRATION_TEST_TIMEOUT_MS = 180_000;

describe("core-runtime integration", () => {
  // 真实环境下验证 facade 的 register/launch/relay/stop 全链路
  integrationTest(
    "runs the real core facade chain with the opencode plugin",
    async () => {
      const config = integrationConfig;
      if (!config) {
        return;
      }

      const runtime = createCoreRuntime();
      const instanceId = config.instanceId!;
      const nodeId = config.nodeId ?? "local-default";
      const launchSpec = buildLaunchSpec(config);
      const launchTimeoutMs = config.launchTimeoutMs ?? 30_000;
      const relayReadyDelayMs = config.relayReadyDelayMs ?? 1_000;
      const responseTimeoutMs = config.responseTimeoutMs ?? 120_000;
      let relay: ObservableRelayHandle | null = null;

      try {
        await runStep("registerPlugin", async () => {
          runtime.registerPlugin(createEnginePlugin());
        });
        await runStep("registerNode", async () => {
          runtime.registerNode({
            id: nodeId,
            mode: "local",
            engineTypes: [config.engineType],
            status: "online",
          });
        });
        await runStep("launchInstance", () =>
          withTimeout(
            runtime.launchInstance({
              instanceId,
              engineType: config.engineType,
              nodeId,
              launchSpec,
            }),
            launchTimeoutMs,
            "launchInstance",
          ),
        );
        relay = await runStep("connectRelay", async () =>
          requireObservableRelay(
            await runtime.connectInstanceRelay({
              instanceId,
            }),
          ),
        );
        const connectedRelay = relay;

        if (relayReadyDelayMs > 0) {
          await Bun.sleep(relayReadyDelayMs);
        }

        const responsePromise = runStep("waitForExpectedResponse", () =>
          waitForExpectedResponse(connectedRelay, config.relay.successMatch, responseTimeoutMs),
        );

        await runStep("sendRequestMessagesInOrder", () =>
          sendRequestMessagesInOrder(connectedRelay, config.relay.requestMessages, responseTimeoutMs),
        );

        const response = await responsePromise;
        expect(matchesExpectedResponse(response, config.relay.successMatch)).toBe(true);
      } finally {
        if (relay?.state === "open") {
          await relay.close();
        }
        await runStep("stopInstance", () => runtime.stopInstance(instanceId));
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
