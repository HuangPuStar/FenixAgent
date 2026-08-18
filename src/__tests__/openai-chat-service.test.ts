import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  createAgentSession,
  openAgentSession,
  setAgentChatServiceDeps,
  startPromptTurn,
} from "../services/agent-chat-service";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

function makeMockRelayHandle(overrides: Record<string, unknown> = {}) {
  return {
    state: "open" as const,
    send: () => {},
    close: async () => {},
    onMessage: () => () => {},
    ready: Promise.resolve(),
    ...overrides,
  };
}

describe("createAgentSession", () => {
  // 正常创建
  test("根据已有 relayHandle 创建 AgentSession", () => {
    const handle = makeMockRelayHandle();
    let _stopped = false;
    const session = createAgentSession({
      relayHandle: handle,
      instanceId: "inst-test",
      stopInstance: async () => {
        _stopped = true;
      },
    });
    expect(session.instanceId).toBe("inst-test");
    expect(session.relayHandle).toBe(handle);
  });

  // dispose 清理
  test("dispose 关闭 relay handle 并 stop 实例", async () => {
    let closed = false;
    let stopped = false;
    const handle = makeMockRelayHandle({
      close: async () => {
        closed = true;
      },
    });
    const session = createAgentSession({
      relayHandle: handle,
      instanceId: "inst-test",
      stopInstance: async () => {
        stopped = true;
      },
    });
    await session.dispose();
    expect(closed).toBe(true);
    expect(stopped).toBe(true);
  });
});

describe("startPromptTurn", () => {
  // 正常 session/new + prompt
  test("创建 session 并返回 PromptTurn", async () => {
    let handler: (msg: any) => void = () => {};
    const handle = makeMockRelayHandle({
      send: (_msg: any) => {
        const method = (_msg as any)?.method;
        if (method === "session/new") {
          // 回显请求携带的 id（而非固定 -1）：rpcId 已改为进程内唯一生成，固定回显会使响应失配
          const reqId = (_msg as any)?.id;
          setTimeout(() => {
            handler({ jsonrpc: "2.0", id: reqId, result: { sessionId: "ses_test123" } });
          }, 5);
        }
      },
      onMessage: (h: any) => {
        handler = h;
        return () => {};
      },
    });

    const session = createAgentSession({
      relayHandle: handle,
      instanceId: "inst-test",
      stopInstance: async () => {},
    });

    const { turn } = await startPromptTurn({ session });
    expect(turn).toBeDefined();
    expect(turn.events).toBeDefined();
    expect(turn.prompt).toBeDefined();
  });

  // 新会话必须在发送 session/new 前完成 workspace/Skills 刷新。
  test("新建 session 时先刷新环境再发送 session/new", async () => {
    const calls: string[] = [];
    let handler: (msg: any) => void = () => {};
    const handle = makeMockRelayHandle({
      send: (_msg: any) => {
        calls.push(_msg.method);
        if (_msg.method === "session/new") {
          const reqId = _msg.id;
          setTimeout(() => handler({ jsonrpc: "2.0", id: reqId, result: { sessionId: "ses_refreshed" } }), 0);
        }
      },
      onMessage: (h: any) => {
        handler = h;
        return () => {};
      },
    });
    const session = createAgentSession({ relayHandle: handle, instanceId: "inst-test" });

    await startPromptTurn({
      session,
      prepareNewSession: async () => {
        calls.push("refresh");
      },
    });

    expect(calls).toEqual(["refresh", "session/new"]);
  });

  // 恢复既有 ACP session 不创建新会话，不应触发新会话环境刷新。
  test("session/load 不刷新新会话环境", async () => {
    let refreshCalls = 0;
    let handler: (msg: any) => void = () => {};
    const handle = makeMockRelayHandle({
      send: (_msg: any) => {
        if (_msg.method === "session/load") {
          const reqId = _msg.id;
          setTimeout(() => handler({ jsonrpc: "2.0", id: reqId, result: { sessionId: "ses_existing" } }), 0);
        }
      },
      onMessage: (h: any) => {
        handler = h;
        return () => {};
      },
    });
    const session = createAgentSession({ relayHandle: handle, instanceId: "inst-test" });

    await startPromptTurn({
      session,
      sessionId: "ses_existing",
      prepareNewSession: async () => {
        refreshCalls++;
      },
    });

    expect(refreshCalls).toBe(0);
  });
});

describe("openAgentSession 失败回滚", () => {
  let stopCalls: string[] = [];
  let closed = false;
  let handler: (msg: unknown) => void = () => {};

  // 默认 fake 依赖：spawn 返回 inst-1，session/new 触发正常 result；用例可局部覆盖
  function defaultDeps() {
    return {
      spawnInstanceViaController: async () => ({ instanceId: "inst-1" }) as never,
      stopInstanceViaController: async (instanceId: string) => {
        stopCalls.push(instanceId);
      },
      connectAgentRelay: async () => {
        const handle = makeMockRelayHandle({
          close: async () => {
            closed = true;
          },
          send: (_msg: unknown) => {
            const msg = _msg as { method?: string };
            if (msg.method === "session/new") {
              // 回显请求携带的 id（而非固定 -1）：rpcId 已改为进程内唯一生成，固定回显会使响应失配
              const reqId = (_msg as { id?: number }).id;
              setTimeout(() => {
                handler({ jsonrpc: "2.0", id: reqId, result: { sessionId: "ses_ok" } });
              }, 5);
            }
          },
          onMessage: (h: unknown) => {
            handler = h as (msg: unknown) => void;
            return () => {};
          },
        }) as never;
        return handle;
      },
    };
  }

  const openInput = {
    userId: "user-1",
    agentConfigId: "123e4567-e89b-12d3-a456-426614174000",
    organizationId: "org-1",
    startSource: "interactive" as const,
  };

  beforeEach(() => {
    stopCalls = [];
    closed = false;
    handler = () => {};
    // environment 查询返回已存在环境，走 openAgentSession 的 existing 分支，
    // 绕开 createWebEnvironment 的 DB 写入链
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ id: "env-1" }]),
          }),
        }),
      }),
    });
    setAgentChatServiceDeps(defaultDeps());
  });

  afterEach(() => {
    setAgentChatServiceDeps(null);
    resetAllStubs();
  });

  // connectAgentRelay 失败（如 relay ready reject）时必须回滚已 spawn 实例，否则泄漏至 idle 回收
  test("connectAgentRelay 抛错时停止已 spawn 实例", async () => {
    setAgentChatServiceDeps({
      connectAgentRelay: async () => {
        throw new Error("relay connect failed");
      },
    });

    await expect(openAgentSession(openInput)).rejects.toThrow("relay connect failed");
    expect(stopCalls).toEqual(["inst-1"]);
  });

  // startPromptTurn 的 session/new 返回 rpc error 时必须先关闭 relay 再停止实例，防止会话中途失败泄漏
  test("session/new rpc error 时关闭 relay 并停止实例", async () => {
    setAgentChatServiceDeps({
      connectAgentRelay: async () => {
        const handle = makeMockRelayHandle({
          close: async () => {
            closed = true;
          },
          send: (_msg: unknown) => {
            const msg = _msg as { method?: string };
            if (msg.method === "session/new") {
              // 回显请求携带的 id（而非固定 -1）：rpcId 已改为进程内唯一生成，固定回显会使响应失配
              const reqId = (_msg as { id?: number }).id;
              setTimeout(() => {
                handler({ jsonrpc: "2.0", id: reqId, error: { message: "session create failed" } });
              }, 5);
            }
          },
          onMessage: (h: unknown) => {
            handler = h as (msg: unknown) => void;
            return () => {};
          },
        }) as never;
        return handle;
      },
    });

    await expect(openAgentSession(openInput)).rejects.toThrow("session create failed");
    expect(stopCalls).toEqual(["inst-1"]);
    expect(closed).toBe(true);
  });

  // 正常完成时不调用 stopInstanceViaController，防止过度回滚
  test("正常路径不触发回滚", async () => {
    const result = await openAgentSession(openInput);
    expect(result.instanceId).toBe("inst-1");
    expect(result.turn).toBeDefined();
    expect(stopCalls).toEqual([]);
  });
});
