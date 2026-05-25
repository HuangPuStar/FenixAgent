import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import type { AgentLaunchSpec, EngineRelayHandle, EngineRelayMessage } from "@mothership/plugin-sdk";
import { createEnginePlugin } from "../src/plugin";

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
  prepareTimeoutMs?: number;
  startTimeoutMs?: number;
  relayReadyDelayMs?: number;
  responseTimeoutMs?: number;
  launchSpec: AgentLaunchSpec;
  relay: IntegrationRelayConfig;
}

interface ObservableRelayHandle extends EngineRelayHandle {
  onMessage(listener: (message: EngineRelayMessage) => void): () => void;
}

// 优先读取本地私有配置，仓库内的公共模板只保留可提交的占位值。
const CONFIG_PATHS = [
  `${import.meta.dirname}/opencode-runtime.local.json`,
  `${import.meta.dirname}/opencode-runtime.conf.json`,
] as const;
const LOG_PREFIX = "[plugin-opencode integration]";

/**
 * 输出集成测试阶段日志，方便定位真实链路失败点。
 */
function logStep(label: string, detail?: unknown): void {
  if (detail === undefined) {
    console.log(`${LOG_PREFIX} ${label}`);
    return;
  }
  console.log(`${LOG_PREFIX} ${label}`, detail);
}

/**
 * 读取集成测试配置；未启用时返回 null，避免常规测试被真实环境阻塞。
 */
function loadIntegrationConfig(): IntegrationTestConfig | null {
  const configPath = CONFIG_PATHS.find((candidate) => existsSync(candidate));
  if (!configPath) {
    return null;
  }

  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as Partial<IntegrationTestConfig>;
  if (!parsed.enabled) {
    return null;
  }

  if (!parsed.launchSpec?.workspace) {
    throw new Error(`Integration config is missing launchSpec.workspace: ${configPath}`);
  }
  if (!parsed.relay?.requestMessages?.length) {
    throw new Error(`Integration config is missing relay.requestMessages: ${configPath}`);
  }

  return {
    enabled: true,
    instanceId: parsed.instanceId ?? `inst_integration_${Date.now()}`,
    prepareTimeoutMs: parsed.prepareTimeoutMs ?? 30_000,
    startTimeoutMs: parsed.startTimeoutMs ?? 30_000,
    relayReadyDelayMs: parsed.relayReadyDelayMs ?? 1_000,
    responseTimeoutMs: parsed.responseTimeoutMs ?? 120_000,
    launchSpec: parsed.launchSpec,
    relay: parsed.relay,
  };
}

/**
 * 保证 connectRelay 返回的句柄具备订阅能力，便于等待真实消息回流。
 */
function requireObservableRelay(handle: EngineRelayHandle): ObservableRelayHandle {
  if (typeof (handle as Partial<ObservableRelayHandle>).onMessage !== "function") {
    throw new Error("Runtime relay handle does not expose onMessage(listener)");
  }
  return handle as ObservableRelayHandle;
}

/**
 * 将 JSON 配置直接转换成运行时需要的 AgentLaunchSpec。
 */
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

/**
 * 给单个异步步骤加上清晰的超时错误，方便定位卡在哪一段链路。
 */
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

/**
 * 运行单个链路步骤，失败时打印当前阶段和原始异常。
 */
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

/**
 * 判断一条 relay 消息是否满足当前测试配置的成功条件。
 */
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

/**
 * 按 ACP 时序发送消息：`new_session` 必须先等到 `session_created`，再允许后续 `prompt`。
 */
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

describe("opencode-runtime integration", () => {
  // 真实环境下串通 prepare/start/connectRelay/send/receive/stop 全链路
  integrationTest(
    "runs the real runtime chain from prepare to stop with a configured hello request",
    async () => {
      const config = integrationConfig;
      if (!config) {
        return;
      }

      const runtime = createEnginePlugin().createRuntime();
      const instanceId = config.instanceId!;
      const launchSpec = buildLaunchSpec(config);
      const prepareTimeoutMs = config.prepareTimeoutMs ?? 30_000;
      const startTimeoutMs = config.startTimeoutMs ?? 30_000;
      const relayReadyDelayMs = config.relayReadyDelayMs ?? 1_000;
      const responseTimeoutMs = config.responseTimeoutMs ?? 120_000;
      let relay: ObservableRelayHandle | null = null;

      try {
        await runStep("prepareEnvironment", () =>
          withTimeout(
            runtime.prepareEnvironment({
              instanceId,
              launchSpec,
            }),
            prepareTimeoutMs,
            "prepareEnvironment",
          ),
        );

        await runStep("startInstance", () =>
          withTimeout(
            runtime.startInstance({
              instanceId,
            }),
            startTimeoutMs,
            "startInstance",
          ),
        );

        relay = await runStep("connectRelay", async () =>
          requireObservableRelay(
            await runtime.connectRelay({
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
        await runtime.stopInstance({ instanceId });
      }
    },
    INTEGRATION_TEST_TIMEOUT_MS,
  );
});
