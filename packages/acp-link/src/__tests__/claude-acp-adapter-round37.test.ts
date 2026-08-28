import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAcpConnection, resolvePromptTargetSession, type SessionState } from "../client/claude-acp-adapter";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-adapter-round37-"));
  workspaces.push(path);
  return path;
}

function connection(path: string, sent: unknown[] = []) {
  return createClaudeAcpConnection(path, "fake-connection", (message) => sent.push(message));
}

function notification(sent: unknown[], index = 0): Record<string, unknown> {
  return sent[index] as Record<string, unknown>;
}

function state(sessionId: string): SessionState {
  return { sessionId, cwd: "/workspace", createdAt: 1, title: sessionId };
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Claude adapter round37 fake connection", () => {
  const titles = [
    "发布检查",
    "故障复盘",
    "权限审计",
    "多语言标题",
    "含 空格 的标题",
    "emoji-free-title",
    "v1.2.3",
    "路径 /tmp/project",
    "引号'标题'",
    "双引号标题",
    "换行前标题",
    "安全边界",
  ];

  for (const title of titles) {
    // 每个真实标题均应逐字保留，避免 session/new 翻译时损坏用户元数据。
    test(`会话生命周期保留标题：${title}`, async () => {
      const path = await workspace();
      const conn = connection(path);
      const created = await conn.newSession({ title });
      const listed = await conn.listSessions({});
      const loaded = await conn.loadSession({ sessionId: created.sessionId });

      expect(created.title).toBe(title);
      expect(listed.sessions).toContainEqual(
        expect.objectContaining({ sessionId: created.sessionId, title, cwd: path }),
      );
      expect(loaded.sessionId).toBe(created.sessionId);
    });
  }

  const modes = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk"];
  for (const modeId of modes) {
    // 每种已声明权限模式都必须回显给后续 session/new，能力不能在连接间串扰。
    test(`权限模式隔离并回显：${modeId}`, async () => {
      const first = connection(await workspace());
      const second = connection(await workspace());
      await first.setSessionMode({ modeId });

      const [firstSession, secondSession] = await Promise.all([first.newSession({}), second.newSession({})]);

      expect(firstSession.modes.currentModeId).toBe(modeId);
      expect(secondSession.modes.currentModeId).toBe("acceptEdits");
    });
  }

  const models = ["claude-sonnet-4-6", "claude-opus-4-8", "claude-haiku-4-5-20251001"];
  for (const modelId of models) {
    // 允许模型应成为当前连接的协商结果，而非污染另一个 fake connection。
    test(`模型能力隔离并回显：${modelId}`, async () => {
      const first = connection(await workspace());
      const second = connection(await workspace());
      await first.unstable_setSessionModel({ modelId });

      const [firstSession, secondSession] = await Promise.all([first.newSession({}), second.newSession({})]);

      expect(firstSession.models.currentModelId).toBe(modelId);
      expect(secondSession.models.currentModelId).toBe("claude-sonnet-4-6");
    });
  }

  const invalidModes: Array<{ value: unknown; expected: string }> = [
    { value: undefined, expected: "bypassPermissions" },
    { value: null, expected: "bypassPermissions" },
    { value: "", expected: "plan" },
    { value: "unknown", expected: "plan" },
    { value: 0, expected: "plan" },
    { value: false, expected: "plan" },
    { value: {}, expected: "plan" },
    { value: [], expected: "plan" },
  ];
  for (const { value: modeId, expected } of invalidModes) {
    // 缺失 modeId 使用兼容默认值；其余非法值必须保持既有安全模式，不能隐式切换。
    test(`非法权限模式按协议回退：${String(modeId)}`, async () => {
      const conn = connection(await workspace());
      await conn.setSessionMode({ modeId: "plan" });
      await conn.setSessionMode({ modeId });

      expect((await conn.newSession({})).modes.currentModeId).toBe(expected);
    });
  }

  const invalidModels: Array<{ value: unknown; expected: string }> = [
    { value: undefined, expected: "claude-sonnet-4-6" },
    { value: null, expected: "claude-sonnet-4-6" },
    { value: "", expected: "claude-opus-4-8" },
    { value: "unknown", expected: "claude-opus-4-8" },
    { value: 7, expected: "claude-opus-4-8" },
    { value: false, expected: "claude-opus-4-8" },
    { value: {}, expected: "claude-opus-4-8" },
    { value: [], expected: "claude-opus-4-8" },
  ];
  for (const { value: modelId, expected } of invalidModels) {
    // 缺失 modelId 使用连接默认模型；其余非法值不得覆盖已验证模型。
    test(`非法模型按协议回退：${String(modelId)}`, async () => {
      const conn = connection(await workspace());
      await conn.unstable_setSessionModel({ modelId: "claude-opus-4-8" });
      await conn.unstable_setSessionModel({ modelId });

      expect((await conn.newSession({})).models.currentModelId).toBe(expected);
    });
  }

  const permissionCases: Array<{ toolName: unknown; toolArgs: unknown; expectedName: unknown; expectedArgs: unknown }> =
    [
      {
        toolName: "Read",
        toolArgs: { file_path: "/safe/a" },
        expectedName: "Read",
        expectedArgs: { file_path: "/safe/a" },
      },
      {
        toolName: "Write",
        toolArgs: { file_path: "/safe/b" },
        expectedName: "Write",
        expectedArgs: { file_path: "/safe/b" },
      },
      { toolName: "Bash", toolArgs: { command: "pwd" }, expectedName: "Bash", expectedArgs: { command: "pwd" } },
      {
        toolName: "Edit",
        toolArgs: { file_path: "/safe/c" },
        expectedName: "Edit",
        expectedArgs: { file_path: "/safe/c" },
      },
      { toolName: "Glob", toolArgs: { pattern: "*.ts" }, expectedName: "Glob", expectedArgs: { pattern: "*.ts" } },
      { toolName: "Grep", toolArgs: { pattern: "TODO" }, expectedName: "Grep", expectedArgs: { pattern: "TODO" } },
      { toolName: undefined, toolArgs: undefined, expectedName: "unknown", expectedArgs: {} },
      {
        toolName: undefined,
        toolArgs: { nested: { enabled: true } },
        expectedName: "unknown",
        expectedArgs: { nested: { enabled: true } },
      },
    ];

  for (const item of permissionCases) {
    // 权限回调翻译为 session/update，且无会话时 sessionId 必须保持 null。
    test(`权限通知翻译：${String(item.expectedName)}`, async () => {
      const sent: unknown[] = [];
      const conn = connection(await workspace(), sent);
      const result = await conn.requestPermission({ toolName: item.toolName, toolArgs: item.toolArgs });
      const message = notification(sent);
      const params = message.params as Record<string, unknown>;
      const update = params.update as Record<string, unknown>;
      const content = update.content as Record<string, unknown>;

      expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
      expect(message).toMatchObject({ jsonrpc: "2.0", method: "session/update" });
      expect(params.sessionId).toBeNull();
      expect(update.sessionUpdate).toBe("permission_request");
      expect(content.toolName).toEqual(item.expectedName);
      expect(content.toolArgs).toEqual(item.expectedArgs);
      expect(content.timestamp).toBeTypeOf("number");
    });
  }

  test("权限通知绑定最后创建的会话", async () => {
    const sent: unknown[] = [];
    const conn = connection(await workspace(), sent);
    const first = await conn.newSession({ title: "旧会话" });
    const second = await conn.newSession({ title: "新会话" });
    await conn.requestPermission({ toolName: "Read", toolArgs: {} });

    expect((notification(sent).params as Record<string, unknown>).sessionId).toBe(second.sessionId);
    expect(second.sessionId).not.toBe(first.sessionId);
  });

  test("加载会话后权限通知绑定被加载会话", async () => {
    const sent: unknown[] = [];
    const conn = connection(await workspace(), sent);
    const first = await conn.newSession({});
    await conn.newSession({});
    await conn.loadSession({ sessionId: first.sessionId });
    await conn.requestPermission({ toolName: "Read", toolArgs: {} });

    expect((notification(sent).params as Record<string, unknown>).sessionId).toBe(first.sessionId);
  });

  test("发送通知失败会向调用方暴露错误", async () => {
    const conn = createClaudeAcpConnection(await workspace(), "fake-connection", () => {
      throw new Error("发送失败");
    });

    await expect(conn.requestPermission({ toolName: "Read", toolArgs: {} })).rejects.toThrow("发送失败");
  });

  const cancellationInputs: Array<Record<string, unknown>> = [
    {},
    { sessionId: "missing" },
    { sessionId: null },
    { sessionId: "" },
  ];
  for (const params of cancellationInputs) {
    // 无活动 query 的取消必须幂等，不应额外发出通知或破坏 session 生命周期。
    test(`取消空闲会话保持幂等：${JSON.stringify(params)}`, async () => {
      const sent: unknown[] = [];
      const conn = connection(await workspace(), sent);
      const created = await conn.newSession({ title: "待保留" });

      await expect(conn.cancel(params)).resolves.toBeUndefined();
      expect((await conn.listSessions({})).sessions).toContainEqual(
        expect.objectContaining({ sessionId: created.sessionId }),
      );
      expect(sent).toEqual([]);
    });
  }

  test("初始化能力对象在连接间不共享引用", async () => {
    const first = connection(await workspace());
    const second = connection(await workspace());
    const firstCapabilities = (await first.initialize()).agentCapabilities;
    const secondCapabilities = (await second.initialize()).agentCapabilities;

    expect(firstCapabilities).toEqual(secondCapabilities);
    expect(firstCapabilities).not.toBe(secondCapabilities);
    expect(firstCapabilities.mcpCapabilities).not.toBe(secondCapabilities.mcpCapabilities);
    expect(firstCapabilities.promptCapabilities).not.toBe(secondCapabilities.promptCapabilities);
  });

  test("未知加载在无活跃会话时返回空标识和工作目录", async () => {
    const path = await workspace();
    const conn = connection(path);

    expect(await conn.loadSession({ sessionId: "missing" })).toEqual({ sessionId: "", cwd: path });
  });

  test("未知加载不覆盖既有活跃会话", async () => {
    const path = await workspace();
    const conn = connection(path);
    const created = await conn.newSession({});

    expect(await conn.loadSession({ sessionId: "missing" })).toEqual({ sessionId: created.sessionId, cwd: path });
  });

  test("空标题使用连续默认名称", async () => {
    const conn = connection(await workspace());
    const first = await conn.newSession({ title: "" });
    const second = await conn.newSession({ title: null });

    expect(first.title).toBe("Conversation 1");
    expect(second.title).toBe("Conversation 2");
  });

  test("会话列表维持创建顺序", async () => {
    const conn = connection(await workspace());
    const first = await conn.newSession({ title: "第一项" });
    const second = await conn.newSession({ title: "第二项" });

    expect((await conn.listSessions({})).sessions.map((item) => item.sessionId)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
  });

  test("prompt 目标优先使用已知请求会话", () => {
    const sessions = new Map([
      ["active", state("active")],
      ["requested", state("requested")],
    ]);

    expect(resolvePromptTargetSession({ sessionId: "requested" }, sessions, "active")).toEqual({
      targetSessionId: "requested",
      targetSession: state("requested"),
    });
  });

  test("prompt 的未知请求会话回退到活跃会话", () => {
    const sessions = new Map([["active", state("active")]]);

    expect(resolvePromptTargetSession({ sessionId: "missing" }, sessions, "active")).toEqual({
      targetSessionId: "active",
      targetSession: undefined,
    });
  });

  test("prompt 无请求会话时使用活跃会话", () => {
    const sessions = new Map([["active", state("active")]]);

    expect(resolvePromptTargetSession({}, sessions, "active")).toEqual({
      targetSessionId: "active",
      targetSession: state("active"),
    });
  });

  test("prompt 在没有已知会话时保持 null 目标", () => {
    expect(resolvePromptTargetSession({}, new Map(), null)).toEqual({
      targetSessionId: null,
      targetSession: undefined,
    });
  });
});
