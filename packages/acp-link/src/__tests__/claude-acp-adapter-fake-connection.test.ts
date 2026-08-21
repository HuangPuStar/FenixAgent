import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAcpConnection } from "../client/claude-acp-adapter";

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
  const workspace = await mkdtemp(join(tmpdir(), "claude-acp-connection-"));
  workspaces.push(workspace);
  return workspace;
}

function createConnection(workspace: string, messages: unknown[] = []) {
  return createClaudeAcpConnection(workspace, "fake-instance", (message) => messages.push(message));
}

function messageText(message: unknown): string {
  return JSON.stringify(message);
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => rm(workspace, { force: true, recursive: true })));
});

describe("Claude ACP adapter 真实 fake connection 生命周期", () => {
  // 连接初始化只协商能力，不应创建隐式会话或向 transport 发送通知。
  test("初始化不产生会话副作用", async () => {
    const messages: unknown[] = [];
    const connection = createConnection(await createWorkspace(), messages);

    await connection.initialize();
    const sessions = await connection.listSessions({});

    expect(sessions.sessions).toEqual([]);
    expect(messages).toEqual([]);
  });

  // 空标题应使用连续的安全默认标题，不能把空字符串暴露给 ACP 客户端。
  test("空标题创建连续的默认会话标题", async () => {
    const connection = createConnection(await createWorkspace());

    const first = await connection.newSession({ title: "" });
    const second = await connection.newSession({});

    expect(first.title).toBe("Conversation 1");
    expect(second.title).toBe("Conversation 2");
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  // 显式标题必须原样保存并在 listSessions 中可见，供客户端恢复会话列表。
  test("显式标题在会话列表中保持原样", async () => {
    const connection = createConnection(await createWorkspace());
    const created = await connection.newSession({ title: "部署前审查" });

    const listed = await connection.listSessions({});

    expect(listed.sessions).toHaveLength(1);
    expect(listed.sessions[0]).toMatchObject({ sessionId: created.sessionId, title: "部署前审查" });
    expect(Number.isNaN(Date.parse(listed.sessions[0]?.updatedAt ?? ""))).toBe(false);
  });

  // loadSession 切换 active session 后，未知加载必须保留该安全上下文而非清空为攻击者提供的 ID。
  test("未知加载保留最后一个已知会话", async () => {
    const workspace = await createWorkspace();
    const connection = createConnection(workspace);
    const first = await connection.newSession({ title: "甲" });
    const second = await connection.newSession({ title: "乙" });

    await connection.loadSession({ sessionId: first.sessionId });
    const missing = await connection.loadSession({ sessionId: "不存在的会话" });

    expect(missing).toEqual({ sessionId: first.sessionId, cwd: workspace });
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  // 已知加载需要返回当前模型、模式及完整可选项，避免客户端丢失协商状态。
  test("加载已知会话返回当前能力状态", async () => {
    const connection = createConnection(await createWorkspace());
    const created = await connection.newSession({});
    await connection.setSessionMode({ modeId: "plan" });
    await connection.unstable_setSessionModel({ modelId: "claude-haiku-4-5-20251001" });

    const loaded = await connection.loadSession({ sessionId: created.sessionId });

    expect(loaded.sessionId).toBe(created.sessionId);
    expect(loaded.modes?.currentModeId).toBe("plan");
    expect(loaded.models?.currentModelId).toBe("claude-haiku-4-5-20251001");
    expect(loaded.models?.availableModels.map((model) => model.modelId)).toContain("claude-opus-4-8");
  });

  // 所有声明模式都可切换，最后一次有效设置决定后续 newSession 的协商值。
  test("所有声明的模式都可被依次选择", async () => {
    const connection = createConnection(await createWorkspace());
    const modes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];

    for (const modeId of modes) {
      await connection.setSessionMode({ modeId });
      const created = await connection.newSession({});
      expect(created.modes.currentModeId).toBe(modeId);
    }
  });

  // 非字符串模式值不应触发异常或覆盖已有选择。
  test("非字符串模式值不会覆盖当前模式", async () => {
    const connection = createConnection(await createWorkspace());
    await connection.setSessionMode({ modeId: "plan" });

    await connection.setSessionMode({ modeId: 42 });
    const created = await connection.newSession({});

    expect(created.modes.currentModeId).toBe("plan");
  });

  // 非字符串模型值和未知模型都必须被拒绝，已选模型保持可用。
  test("非法模型值不会覆盖当前模型", async () => {
    const connection = createConnection(await createWorkspace());
    await connection.unstable_setSessionModel({ modelId: "claude-opus-4-8" });

    await connection.unstable_setSessionModel({ modelId: 42 });
    await connection.unstable_setSessionModel({ modelId: "not-a-claude-model" });
    const created = await connection.newSession({});

    expect(created.models.currentModelId).toBe("claude-opus-4-8");
  });

  // 没有会话时权限请求仍可翻译为通知；sessionId 保持 null 而非伪造会话 ID。
  test("无会话权限请求发送安全的 null 会话标识", async () => {
    const messages: unknown[] = [];
    const connection = createConnection(await createWorkspace(), messages);

    const result = await connection.requestPermission({ toolName: "Read", toolArgs: { file_path: "/safe/path" } });

    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect(messages).toHaveLength(1);
    expect(messageText(messages[0])).toContain('"sessionId":null');
    expect(messageText(messages[0])).toContain('"toolName":"Read"');
  });

  // 切换会话后权限通知必须定位当前 active session，不能泄漏到先前会话。
  test("权限通知跟随已加载的目标会话", async () => {
    const messages: unknown[] = [];
    const connection = createConnection(await createWorkspace(), messages);
    const first = await connection.newSession({});
    const second = await connection.newSession({});

    await connection.loadSession({ sessionId: first.sessionId });
    await connection.requestPermission({ toolName: "Bash", toolArgs: {} });

    expect(messageText(messages[0])).toContain(`"sessionId":"${first.sessionId}"`);
    expect(messageText(messages[0])).not.toContain(second.sessionId);
  });

  // 两个真实 connection 的会话、模型和模式状态完全隔离，避免多实例串扰。
  test("多个连接隔离模式模型和会话列表", async () => {
    const first = createConnection(await createWorkspace());
    const second = createConnection(await createWorkspace());
    await first.setSessionMode({ modeId: "plan" });
    await first.unstable_setSessionModel({ modelId: "claude-opus-4-8" });
    const firstSession = await first.newSession({ title: "连接一" });
    const secondSession = await second.newSession({ title: "连接二" });

    const [firstList, secondList] = await Promise.all([first.listSessions({}), second.listSessions({})]);

    expect(firstSession.modes.currentModeId).toBe("plan");
    expect(firstSession.models.currentModelId).toBe("claude-opus-4-8");
    expect(secondSession.modes.currentModeId).toBe("acceptEdits");
    expect(secondSession.models.currentModelId).toBe("claude-sonnet-4-6");
    expect(firstList.sessions.map((session) => session.title)).toEqual(["连接一"]);
    expect(secondList.sessions.map((session) => session.title)).toEqual(["连接二"]);
  });

  // cancel 在不同 session 和空参数下都是幂等 no-op，不能影响 transport 或现有会话。
  test("取消未知会话不改变连接状态", async () => {
    const messages: unknown[] = [];
    const connection = createConnection(await createWorkspace(), messages);
    const created = await connection.newSession({ title: "保持" });

    await connection.cancel({ sessionId: "other-session" });
    await connection.cancel({});

    expect((await connection.listSessions({})).sessions).toMatchObject([
      { sessionId: created.sessionId, title: "保持" },
    ]);
    expect(messages).toEqual([]);
  });
});
