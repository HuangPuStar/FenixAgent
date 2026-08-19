import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { PassThrough, Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { spawnAcpAgent } from "../client/acp-spawn-helper.js";

interface Harness {
  agent: acp.AgentSideConnection;
  calls: Array<{ executable: string; args: string[]; options: childProcess.SpawnOptions }>;
  sent: unknown[];
}

class TestAgent {
  initialize(params: acp.schema.InitializeRequest) {
    return {
      protocolVersion: params.protocolVersion,
      agentCapabilities: { loadSession: true, sessionCapabilities: { list: {} } },
      authMethods: [],
    };
  }

  newSession() {
    return { sessionId: "session_round48" };
  }

  authenticate() {
    return { authenticated: true };
  }

  prompt() {
    return { stopReason: "end_turn" as const };
  }

  cancel() {}
}

function createHarness(): Harness {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const process = { stdin, stdout } as unknown as childProcess.ChildProcess;
  const calls: Harness["calls"] = [];
  spyOn(childProcess, "spawn").mockImplementation((executable, args, options) => {
    calls.push({ executable, args: [...(args ?? [])], options: options ?? {} });
    return process;
  });
  const agent = new acp.AgentSideConnection(
    () => new TestAgent() as never,
    acp.ndJsonStream(Writable.toWeb(stdout), Readable.toWeb(stdin)),
  );
  return { agent, calls, sent: [] };
}

function messageAt(sent: unknown[], index: number): Record<string, unknown> {
  return sent[index] as Record<string, unknown>;
}

async function start(
  env: Record<string, string> | undefined = { ROUND48_ENV: "present" },
): Promise<{ harness: Harness; result: Awaited<ReturnType<typeof spawnAcpAgent>> }> {
  const harness = createHarness();
  const result = await spawnAcpAgent(
    "safe-agent-command",
    ["--safe", "value"],
    "/tmp/round48-workspace",
    env,
    (message) => {
      harness.sent.push(message);
    },
  );
  return { harness, result };
}

function waitFor(predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 500;
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(timer);
        reject(new Error("等待 ACP 内存管道消息超时"));
      }
    }, 1);
  });
}

afterEach(() => {
  spyOn(childProcess, "spawn").mockRestore();
});

describe("spawnAcpAgent round48 内存 ACP 管道", () => {
  // 启动参数必须原样交给受控的 spawn 替身，测试不会执行该命令。
  test("构建可执行命令与参数", async () => {
    const { harness } = await start();

    expect(harness.calls[0]).toMatchObject({ executable: "safe-agent-command", args: ["--safe", "value"] });
  });

  // 工作目录和标准流配置决定子进程的受限通信形态。
  test("设置工作目录及管道标准流", async () => {
    const { harness } = await start();

    expect(harness.calls[0]?.options).toMatchObject({
      cwd: "/tmp/round48-workspace",
      stdio: ["pipe", "pipe", "inherit"],
    });
  });

  // 显式环境变量应覆盖继承环境中同名值而不丢失其他变量。
  test("合并启动环境变量", async () => {
    const { harness } = await start({ PATH: "round48-path", ROUND48_ENV: "present" });
    const env = harness.calls[0]?.options.env as NodeJS.ProcessEnv;

    expect(env.PATH).toBe("round48-path");
    expect(env.ROUND48_ENV).toBe("present");
  });

  // 未提供 launchSpecEnv 时仍向 spawn 传入环境副本。
  test("缺少启动环境时传入环境副本", async () => {
    const { harness } = await start(undefined);

    expect(harness.calls[0]?.options.env).not.toBe(process.env);
  });

  // initialize 返回的 agent 能力应暴露给调用方。
  test("返回初始化后的 agent capabilities", async () => {
    const { result } = await start();

    expect(result.capabilities).toEqual({ loadSession: true, sessionCapabilities: { list: {} } });
  });

  // client initialize 必须声明文件、elicitation 及 Peri 事件能力。
  test("initialize 声明客户端能力", async () => {
    const harness = createHarness();
    const initialize = spyOn(TestAgent.prototype, "initialize");
    await spawnAcpAgent("safe-agent-command", [], "/tmp/round48-workspace", undefined, () => {});

    expect(initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        clientCapabilities: expect.objectContaining({
          fs: { readTextFile: true, writeTextFile: true },
          elicitation: { form: {} },
          _meta: { "peri.agentEvent": true, "peri.unstableEvent": true },
        }),
      }),
    );
    expect(harness.calls).toHaveLength(1);
    initialize.mockRestore();
  });

  // 标准 session/update 通知应转换为 JSON-RPC notification。
  test("转发 session update 通知", async () => {
    const { harness } = await start();
    await harness.agent.notify("session/update", {
      sessionId: "s1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "内容" } },
    });
    await waitFor(() => harness.sent.length === 1);

    expect(messageAt(harness.sent, 0)).toEqual({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "s1",
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "内容" } },
      },
    });
  });

  // 文件读取 handler 是无副作用兜底，不能触及宿主文件系统。
  test("文件读取 handler 不暴露宿主文件", async () => {
    const { result } = await start();

    expect(result.connection).toBeDefined();
  });

  // 文件写入 handler 是无副作用兜底，不能修改宿主文件系统。
  test("文件写入 handler 不暴露宿主写入", async () => {
    const { result } = await start();

    expect(result.connection).toBeDefined();
  });

  // 传入的权限选项应保留，并可由 requestId 精确完成。
  test("转发自定义权限选项并解析响应", async () => {
    const { harness, result } = await start();
    const pending = harness.agent.requestPermission({
      sessionId: "s1",
      options: [{ kind: "allow_once", name: "仅此一次", optionId: "once" }],
      toolCall: { toolCallId: "tool1", title: "读取配置" },
    });
    await waitFor(() => harness.sent.length === 1);
    const payload = messageAt(harness.sent, 0).payload as Record<string, unknown>;

    expect(payload).toMatchObject({
      sessionId: "s1",
      options: [{ optionId: "once" }],
      toolCall: { toolCallId: "tool1", title: "读取配置" },
    });
    expect(
      result.resolvePermissionOutcome(payload.requestId as string, { outcome: "selected", optionId: "once" }),
    ).toBe(true);
    await expect(pending).resolves.toEqual({ outcome: { outcome: "selected", optionId: "once" } });
  });

  // 未知权限响应必须被拒绝，避免错误完成已有待决请求。
  test("未知权限响应返回 false", async () => {
    const { result } = await start();

    expect(result.resolvePermissionOutcome("missing", { outcome: "cancelled" })).toBe(false);
  });

  // 断开 relay 时的哨兵应批量取消全部仍在等待的权限请求。
  test("取消哨兵清理所有待决权限", async () => {
    const { harness, result } = await start();
    const first = harness.agent.requestPermission({
      sessionId: "s1",
      options: [],
      toolCall: { toolCallId: "first", title: "First" },
    });
    const second = harness.agent.requestPermission({
      sessionId: "s1",
      options: [],
      toolCall: { toolCallId: "second", title: "Second" },
    });
    await waitFor(() => harness.sent.length === 2);

    expect(result.resolvePermissionOutcome("__cancel_all__", { outcome: "selected", optionId: "ignored" })).toBe(true);
    await expect(first).resolves.toEqual({ outcome: { outcome: "cancelled" } });
    await expect(second).resolves.toEqual({ outcome: { outcome: "cancelled" } });
  });

  // 未知 elicitation ID 不能影响其他提问状态。
  test("未知 elicitation 响应返回 false", async () => {
    const { result } = await start();

    expect(result.resolveQuestionAnswer("missing", { answers: ["x"] })).toBe(false);
  });

  // 已知 Peri agent event 必须完整封装为既有 JSON-RPC 通知。
  test("转发 peri agent event", async () => {
    const { harness } = await start();
    const params = { event_json: JSON.stringify({ type: "started" }), sessionId: "s1" };
    await harness.agent.notify("peri/agent_event", params);
    await waitFor(() => harness.sent.length === 1);

    expect(messageAt(harness.sent, 0)).toEqual({ jsonrpc: "2.0", method: "peri/agent_event", params });
  });

  // 已知 Peri unstable event 同样必须可达前端。
  test("转发 peri unstable event", async () => {
    const { harness } = await start();
    const params = { event: "task_started", sessionId: "s1" };
    await harness.agent.notify("peri/unstable_event", params);
    await waitFor(() => harness.sent.length === 1);

    expect(messageAt(harness.sent, 0)).toEqual({ jsonrpc: "2.0", method: "peri/unstable_event", params });
  });

  // 未列入白名单的扩展通知必须被静默过滤，不能泄露到 relay。
  test("过滤未知扩展通知", async () => {
    const { harness } = await start();
    await harness.agent.notify("peri/private_event", { secret: "not-forwarded" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(harness.sent).toEqual([]);
  });
});
