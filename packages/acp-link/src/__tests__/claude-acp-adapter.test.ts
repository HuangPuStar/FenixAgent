import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAcpConnection } from "../client/claude-acp-adapter";

interface SentJsonRpc {
  jsonrpc: "2.0";
  method: "session/update";
  params: {
    sessionId: string;
    update: {
      sessionUpdate: string;
      content: Record<string, unknown>;
    };
  };
}

interface ClaudeConnection {
  initialize(): Promise<{
    protocolVersion: number;
    agentCapabilities: {
      loadSession: boolean;
      mcpCapabilities: { http: boolean; sse: boolean };
      promptCapabilities: { embeddedContext: boolean; image: boolean };
      sessionCapabilities: { list: Record<string, never>; resume: Record<string, never> };
    };
  }>;
  newSession(params: Record<string, unknown>): Promise<{
    sessionId: string;
    title: string;
    models: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> };
    modes: { currentModeId: string; availableModes: Array<{ modeId: string }> };
  }>;
  listSessions(params: Record<string, unknown>): Promise<{
    sessions: Array<{ sessionId: string; cwd: string; title: string; updatedAt: string }>;
  }>;
  loadSession(params: Record<string, unknown>): Promise<{
    sessionId: string;
    cwd: string;
    models?: { currentModelId: string };
    modes?: { currentModeId: string };
  }>;
  setSessionMode(params: Record<string, unknown>): Promise<void>;
  unstable_setSessionModel(params: Record<string, unknown>): Promise<void>;
  requestPermission(params: Record<string, unknown>): Promise<{ outcome: { outcome: "selected"; optionId: string } }>;
  cancel(params: Record<string, unknown>): Promise<void>;
}

function createConnection(workspace: string, sent: SentJsonRpc[]): ClaudeConnection {
  return createClaudeAcpConnection(workspace, "instance-test", (message) => {
    sent.push(message as SentJsonRpc);
  }) as unknown as ClaudeConnection;
}

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "claude-acp-adapter-test-"));
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })));
});

describe("Claude ACP adapter 纯协议适配", () => {
  // initialize 必须声明 Claude adapter 实际支持的 MCP、图像和会话能力，供 dispatcher 及客户端安全协商
  test("initialize 返回稳定的协议版本与能力集", async () => {
    const connection = createConnection(await createWorkspace(), []);

    const result = await connection.initialize();

    expect(result.agentCapabilities).toEqual({
      loadSession: false,
      mcpCapabilities: { http: true, sse: true },
      promptCapabilities: { embeddedContext: true, image: true },
      sessionCapabilities: { list: {}, resume: {} },
    });
    expect(result.protocolVersion).toBeGreaterThan(0);
  });

  // session/new 创建独立会话状态，并把当前模型、权限模式和可选模型一并返回给 ACP 客户端
  test("newSession 返回会话、模型和模式协商状态", async () => {
    const connection = createConnection(await createWorkspace(), []);

    const result = await connection.newSession({ title: "发布检查" });

    expect(result.sessionId).toStartWith("claude_");
    expect(result.title).toBe("发布检查");
    expect(result.models.currentModelId).toBe("claude-sonnet-4-6");
    expect(result.models.availableModels.map((model) => model.modelId)).toContain("claude-opus-4-8");
    expect(result.modes.currentModeId).toBe("acceptEdits");
    expect(result.modes.availableModes.map((mode) => mode.modeId)).toContain("plan");
  });

  // session/list 与 session/load 必须从连接内存恢复指定会话；未知会话保守保留工作目录且不伪造会话 ID
  test("listSessions 和 loadSession 区分已知与未知会话", async () => {
    const workspace = await createWorkspace();
    const connection = createConnection(workspace, []);
    const first = await connection.newSession({ title: "第一个会话" });
    const second = await connection.newSession({ title: "第二个会话" });

    const listed = await connection.listSessions({});
    const loaded = await connection.loadSession({ sessionId: first.sessionId });
    const unknown = await connection.loadSession({ sessionId: "claude-missing" });

    expect(listed.sessions.map((session) => session.sessionId)).toEqual([first.sessionId, second.sessionId]);
    expect(listed.sessions[0]?.updatedAt).not.toBe("");
    expect(loaded).toMatchObject({ sessionId: first.sessionId, cwd: workspace });
    expect(unknown).toEqual({ sessionId: first.sessionId, cwd: workspace });
  });

  // 仅接受已声明的模式和模型，非法值不得污染后续 session/new 返回的能力状态
  test("模式与模型设置只接受能力列表中的值", async () => {
    const connection = createConnection(await createWorkspace(), []);

    await connection.setSessionMode({ modeId: "plan" });
    await connection.unstable_setSessionModel({ modelId: "claude-opus-4-8" });
    const accepted = await connection.newSession({});
    await connection.setSessionMode({ modeId: "unknown-mode" });
    await connection.unstable_setSessionModel({ modelId: "unknown-model" });
    const rejected = await connection.newSession({});

    expect(accepted.modes.currentModeId).toBe("plan");
    expect(accepted.models.currentModelId).toBe("claude-opus-4-8");
    expect(rejected.modes.currentModeId).toBe("plan");
    expect(rejected.models.currentModelId).toBe("claude-opus-4-8");
  });

  // requestPermission 必须翻译为 session/update，并为缺失字段填充安全默认值且返回 allow 结果
  test("requestPermission 翻译为权限 session/update 并保留工具参数", async () => {
    const sent: SentJsonRpc[] = [];
    const connection = createConnection(await createWorkspace(), sent);
    const created = await connection.newSession({});

    const result = await connection.requestPermission({ toolName: "Bash", toolArgs: { command: "pwd" } });
    const fallbackResult = await connection.requestPermission({});

    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(fallbackResult).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: created.sessionId,
        update: {
          sessionUpdate: "permission_request",
          content: { toolName: "Bash", toolArgs: { command: "pwd" } },
        },
      },
    });
    expect(sent[0]?.params.update.content.timestamp).toBeTypeOf("number");
    expect(sent[1]).toMatchObject({
      params: { update: { content: { toolName: "unknown", toolArgs: {} } } },
    });
  });

  // 无活跃 query 的 cancel 是幂等 no-op，避免 dispatcher 在迟到取消或错误映射时抛出第二个失败
  test("cancel 在无活跃 prompt 时保持幂等且不发送额外事件", async () => {
    const sent: SentJsonRpc[] = [];
    const connection = createConnection(await createWorkspace(), sent);

    await expect(connection.cancel({ sessionId: "claude-none" })).resolves.toBeUndefined();
    await expect(connection.cancel({})).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });
});
