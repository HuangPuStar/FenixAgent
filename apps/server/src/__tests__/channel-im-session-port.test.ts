import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  type AgentInstanceRecord,
  type AgentRuntimeSessionApi,
  type AgentSession,
  type EnvironmentRecord,
  type PromptTurn,
  type PromptTurnStartResult,
  type RuntimeSnapshot,
} from "@fenix/agent-runtime/runtime";
import { resetAgentRuntimePort, stubAgentRuntimePort } from "@fenix/agent-runtime/server/testing";
import { resetAllStubs, stubDb, stubModuleConfig } from "@fenix/platform-sdk/testing";
import { createChannelImSessionPort } from "../services/channel-im-session-port";

/**
 * 宿主 IM 会话端口的并发契约（规格 §6.1 第 5-7 步）。
 *
 * 端口的 `opened` 表只能按句柄定位：同一聊天换 Agent 后并发冷启动会各自打开一个 turn，按 conversationId
 * 定位会让后一次 `openSession` 覆盖前一次，唤醒 prompt 与 close 落到别的会话上。
 */

type RelayHandle = AgentSession["relayHandle"];

interface FakeTurn {
  readonly prompts: string[];
  /** 记录 ACP 下发的 MCP 条目，用来断言订阅元数据的键名。 */
  readonly mcpServers: readonly Record<string, unknown>[];
  released: boolean;
}

interface FakeRuntime {
  readonly api: AgentRuntimeSessionApi;
  /** 按 rcsSessionId 索引的 turn 记录，用来断言唤醒 prompt 命中哪一路会话。 */
  readonly turns: Map<string, FakeTurn>;
}

/** 只实现端口用到的三个动词：connectRelay / createAgentSession / startPromptTurn。 */
function createFakeRuntime(): FakeRuntime {
  const turns = new Map<string, FakeTurn>();
  const relayOwners = new WeakMap<object, string>();
  let sessionSeq = 0;

  const api: AgentRuntimeSessionApi = {
    async connectRelay(_instanceId, rcsSessionId) {
      const relay: RelayHandle & { state: "open" | "closed" } = {
        state: "open",
        send: () => {},
        close: () => {
          relay.state = "closed";
        },
      };
      relayOwners.set(relay, rcsSessionId);
      return relay;
    },
    createAgentSession({ relayHandle, instanceId }) {
      return { relayHandle, instanceId, dispose: async () => {} };
    },
    createPromptTurn() {
      throw new Error("用例不应构造 PromptTurn");
    },
    async startPromptTurn(options): Promise<PromptTurnStartResult> {
      const rcsSessionId = relayOwners.get(options.session.relayHandle);
      if (rcsSessionId === undefined) throw new Error("relay 未经过 connectRelay");
      sessionSeq += 1;
      const record: FakeTurn = { prompts: [], mcpServers: options.mcpServers ?? [], released: false };
      turns.set(rcsSessionId, record);
      const turn: PromptTurn = {
        prompt(content) {
          for (const item of content) record.prompts.push(item.text);
        },
        events: () => (async function* () {})(),
        cancel: async () => {},
        release: () => {
          record.released = true;
        },
        dispose: async () => {},
      };
      return { turn, session: options.session, sessionId: options.sessionId ?? `ses_fake_${sessionSeq}` };
    },
    sendToAgentWs: () => false,
    sendToInstanceRelay: () => false,
    getEventBus() {
      throw new Error("用例不使用事件总线");
    },
    removeEventBus: () => {},
  };

  return { api, turns };
}

const CONVERSATION_ID = "3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b";
const INSTANCE = { instanceId: "instance-1", runtimeToken: "generation-1" } as const;

function target(rcsSessionId: string) {
  return {
    channelId: "channel-1",
    conversationId: CONVERSATION_ID,
    organizationId: "org-1",
    ownerUserId: "owner-1",
    agentConfigId: "agent-1",
    rcsSessionId,
    acpSessionId: null,
  };
}

const ENVIRONMENT: EnvironmentRecord = {
  id: "env-1",
  name: "auto-agent1",
  description: null,
  workspacePath: "/tmp/workspace",
  agentConfigId: "agent-1",
  secret: "env-test-secret",
  machineName: null,
  directory: null,
  branch: null,
  gitRepoUrl: null,
  workerType: "local",
  capabilities: null,
  status: "active",
  username: null,
  userId: "owner-1",
  organizationId: "org-1",
  autoStart: true,
  lastPollAt: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

const INSTANCE_ROW: AgentInstanceRecord = {
  id: "instance-im-1",
  environmentId: ENVIRONMENT.id,
  ownerUserId: "owner-1",
  creationSource: "api",
  name: `im-${CONVERSATION_ID}`,
  isDefault: false,
  createdByUserId: "owner-1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};

function ensureInput() {
  return {
    conversationId: CONVERSATION_ID,
    organizationId: "org-1",
    ownerUserId: "owner-1",
    agentConfigId: "agent-1",
  };
}

/** 具名 api 实例经 insert 创建；只回填一行，避免本用例依赖真实 DB。 */
function stubInstanceCreation(row: AgentInstanceRecord): void {
  stubDb({
    insert: () => ({
      values: () => ({ onConflictDoNothing: () => ({ returning: async () => [row] }) }),
    }),
  });
}

function runtimeSnapshot(generation: number): RuntimeSnapshot {
  return {
    instanceUid: INSTANCE_ROW.id,
    runtimeGeneration: generation,
    operationId: generation,
    state: "running",
    currentOperation: null,
    deleting: false,
    lastFailure: null,
  };
}

interface PortError extends Error {
  readonly code?: string;
  readonly cause?: unknown;
}

async function capturePortError(promise: Promise<unknown>): Promise<PortError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("预期调用失败，但调用成功返回");
}

beforeEach(() => {
  resetAllStubs();
  // 端口在 openSession 里签发逐会话 token；密钥只用于用例，与部署无关。
  stubModuleConfig("channel", { imEventTextTtlHours: 24, imTokenSecret: "im-test-secret" });
});

afterEach(() => {
  resetAgentRuntimePort();
  resetAllStubs();
});

describe("IM 会话端口并发冷启动", () => {
  // 同一聊天换 Agent 后两路冷启动并发打开：各自持有独立句柄，唤醒 prompt 只能落到自己的 turn。
  test("并发打开同一聊天的两路会话互不覆盖", async () => {
    const runtime = createFakeRuntime();
    stubAgentRuntimePort({ session: runtime.api });
    const port = createChannelImSessionPort();

    const [first, second] = await Promise.all([
      port.openSession({ target: target("rcs_first"), instance: INSTANCE }),
      port.openSession({ target: target("rcs_second"), instance: INSTANCE }),
    ]);

    expect(first.handleId).not.toBe(second.handleId);
    expect(first.acpSessionId).not.toBe(second.acpSessionId);

    await port.sendWakePrompt({ session: first, text: "唤醒第一路" });
    await port.sendWakePrompt({ session: second, text: "唤醒第二路" });

    expect(runtime.turns.get("rcs_first")?.prompts).toEqual(["唤醒第一路"]);
    expect(runtime.turns.get("rcs_second")?.prompts).toEqual(["唤醒第二路"]);
  });

  // close 只释放自己那次投递的 turn：先关第一路不能顺带释放第二路，两者关完后不得留下可按句柄命中的条目。
  test("并发句柄各自关闭且不残留", async () => {
    const runtime = createFakeRuntime();
    stubAgentRuntimePort({ session: runtime.api });
    const port = createChannelImSessionPort();

    const [first, second] = await Promise.all([
      port.openSession({ target: target("rcs_first"), instance: INSTANCE }),
      port.openSession({ target: target("rcs_second"), instance: INSTANCE }),
    ]);
    await port.sendWakePrompt({ session: first, text: "唤醒第一路" });
    await port.sendWakePrompt({ session: second, text: "唤醒第二路" });

    await port.close(first);
    expect(runtime.turns.get("rcs_first")?.released).toBe(true);
    expect(runtime.turns.get("rcs_second")?.released).toBe(false);

    await port.close(second);
    expect(runtime.turns.get("rcs_second")?.released).toBe(true);

    await expect(port.sendWakePrompt({ session: first, text: "迟到唤醒" })).rejects.toThrow("尚未打开");
    await expect(port.sendWakePrompt({ session: second, text: "迟到唤醒" })).rejects.toThrow("尚未打开");
  });

  // peri 4.4.1 只认 ACP `_meta["peri.subscriptions"]`；旧键名会让 Agent 永远收不到 IM 入站订阅。
  test("下发的 MCP 条目携带 peri.subscriptions 元数据", async () => {
    const runtime = createFakeRuntime();
    stubAgentRuntimePort({ session: runtime.api });
    const port = createChannelImSessionPort();

    await port.openSession({ target: target("rcs_meta"), instance: INSTANCE });

    const servers = runtime.turns.get("rcs_meta")?.mcpServers ?? [];
    expect(servers).toHaveLength(1);
    expect(servers[0]).toMatchObject({
      name: "im",
      _meta: { "peri.subscriptions": { resources: ["im://inbox"] } },
    });
  });
});

describe("IM 会话端口自动唤醒", () => {
  // 手动停止的实例收到 IM 消息时视为唤醒意图：重启一次，并用重启后的代次返回实例信息。
  test("实例停止时自动唤醒并返回重启后的运行代次", async () => {
    stubInstanceCreation(INSTANCE_ROW);
    let generation = 1;
    const calls: string[] = [];
    stubAgentRuntimePort({
      createEnvironment: async () => ENVIRONMENT,
      ensureInstanceRuntime: async () => {
        calls.push("ensure");
        throw Object.assign(new Error("Agent Instance is stopped"), { code: "INSTANCE_STOPPED" });
      },
      restartInstanceRuntime: async () => {
        calls.push("restart");
        generation += 1;
      },
      getRuntimeSnapshot: () => runtimeSnapshot(generation),
    });
    const port = createChannelImSessionPort();

    const ref = await port.ensureInstance(ensureInput());

    expect(calls).toEqual(["ensure", "restart"]);
    expect(ref).toEqual({ instanceId: INSTANCE_ROW.id, runtimeToken: "2" });
  });

  // 唤醒失败必须带稳定码上抛并保留 cause；上层据此回「唤醒失败」而不是笼统繁忙。
  test("自动唤醒失败时抛出 IM_WAKE_FAILED 并保留 cause", async () => {
    stubInstanceCreation(INSTANCE_ROW);
    const wakeFailure = new Error("sandbox unavailable");
    stubAgentRuntimePort({
      createEnvironment: async () => ENVIRONMENT,
      ensureInstanceRuntime: async () => {
        throw Object.assign(new Error("Agent Instance is stopped"), { code: "INSTANCE_STOPPED" });
      },
      restartInstanceRuntime: async () => {
        throw wakeFailure;
      },
      getRuntimeSnapshot: () => runtimeSnapshot(1),
    });
    const port = createChannelImSessionPort();

    const error = await capturePortError(port.ensureInstance(ensureInput()));

    expect(error.code).toBe("IM_WAKE_FAILED");
    expect(error.message).toContain("sandbox unavailable");
    expect(error.cause).toBe(wakeFailure);
  });

  // 只有 INSTANCE_STOPPED 触发唤醒：其他启动错误保持原样，不做第二次尝试。
  test("其他启动错误不触发唤醒", async () => {
    stubInstanceCreation(INSTANCE_ROW);
    let restarts = 0;
    const startupError = new Error("spawn failed");
    stubAgentRuntimePort({
      createEnvironment: async () => ENVIRONMENT,
      ensureInstanceRuntime: async () => {
        throw startupError;
      },
      restartInstanceRuntime: async () => {
        restarts += 1;
      },
      getRuntimeSnapshot: () => runtimeSnapshot(1),
    });
    const port = createChannelImSessionPort();

    const error = await capturePortError(port.ensureInstance(ensureInput()));

    expect(error).toBe(startupError);
    expect(restarts).toBe(0);
  });
});
