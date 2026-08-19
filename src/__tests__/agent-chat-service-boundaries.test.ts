import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { NotFoundError } from "../errors";
import { openAgentSession, setAgentChatServiceDeps } from "../services/agent-chat-service";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

const VALID_AGENT_CONFIG_ID = "123e4567-e89b-12d3-a456-426614174000";
const OPEN_INPUT = {
  userId: "user-a",
  agentConfigId: VALID_AGENT_CONFIG_ID,
  organizationId: "org-a",
  startSource: "interactive" as const,
};

interface RpcRequest {
  id?: number;
  method?: string;
}

function readRpcRequest(message: EngineRelayMessage): RpcRequest {
  return message as unknown as RpcRequest;
}

function createReplyingRelay(options: { failSessionNew?: boolean } = {}): EngineRelayHandle {
  let listener: ((message: EngineRelayMessage) => void) | undefined;

  return {
    state: "open",
    ready: Promise.resolve(),
    close: () => {},
    onMessage(nextListener) {
      listener = nextListener;
      return () => {
        listener = undefined;
      };
    },
    send(message) {
      const request = readRpcRequest(message);
      if (request.method !== "session/new") return;
      if (options.failSessionNew) throw new Error("session transport rejected");
      listener?.({
        type: "json-rpc",
        payload: { jsonrpc: "2.0", id: request.id, result: { sessionId: "ses-isolated" } },
      });
    },
  };
}

describe("agent-chat-service 输入边界与实例回滚", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    setAgentChatServiceDeps(null);
    resetAllStubs();
  });

  // 非 UUID 的 agentConfigId 必须在查询、创建环境和启动实例之前被拒绝，避免跨组织探测与数据库裸错误。
  test("非法 agentConfigId 在任何持久化或编排操作前返回 NotFoundError", async () => {
    let selectCalls = 0;
    let spawnCalls = 0;
    stubDb({
      select: () => {
        selectCalls += 1;
        return {};
      },
    });
    setAgentChatServiceDeps({
      spawnInstanceViaController: async () => {
        spawnCalls += 1;
        return { instanceId: "inst-unreachable" } as never;
      },
    });

    await expect(openAgentSession({ ...OPEN_INPUT, agentConfigId: "env_other_org" })).rejects.toThrow(NotFoundError);
    expect(selectCalls).toBe(0);
    expect(spawnCalls).toBe(0);
  });

  // 已存在环境只能由组织、Agent 配置和用户三重条件解析；解析结果必须用于当前用户的实例启动。
  test("命中当前组织环境后以解析出的环境和当前用户启动实例", async () => {
    let spawned: { environmentId: string; userId: string; source: string } | undefined;
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: "env-org-a-user-a" }],
          }),
        }),
      }),
    });
    setAgentChatServiceDeps({
      spawnInstanceViaController: async (environmentId, userId, source) => {
        spawned = { environmentId, userId, source };
        return { instanceId: "inst-org-a-user-a" } as never;
      },
      connectAgentRelay: async () => createReplyingRelay(),
      stopInstanceViaController: async () => {},
    });

    const result = await openAgentSession(OPEN_INPUT);

    expect(spawned).toEqual({
      environmentId: "env-org-a-user-a",
      userId: "user-a",
      source: "interactive",
    });
    expect(result.instanceId).toBe("inst-org-a-user-a");
    await result.turn.dispose();
  });

  // relay 建立后 session/new 发送失败时，必须关闭 relay 并停止刚创建的实例，不能遗留并发额度。
  test("session/new 发送失败时关闭 relay 并回滚实例", async () => {
    let relayClosed = false;
    const stoppedInstances: string[] = [];
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [{ id: "env-org-a-user-a" }],
          }),
        }),
      }),
    });
    setAgentChatServiceDeps({
      spawnInstanceViaController: async () => ({ instanceId: "inst-rollback" }) as never,
      connectAgentRelay: async () => ({
        ...createReplyingRelay({ failSessionNew: true }),
        close: () => {
          relayClosed = true;
        },
      }),
      stopInstanceViaController: async (instanceId) => {
        stoppedInstances.push(instanceId);
      },
    });

    await expect(openAgentSession(OPEN_INPUT)).rejects.toThrow("session transport rejected");
    expect(relayClosed).toBe(true);
    expect(stoppedInstances).toEqual(["inst-rollback"]);
  });
});
