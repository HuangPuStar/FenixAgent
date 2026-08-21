import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAcpConnection, resolvePromptTargetSession, type SessionState } from "../client/claude-acp-adapter";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-adapter-round42-"));
  workspaces.push(path);
  return path;
}

function connection(path: string, sent: unknown[] = []) {
  return createClaudeAcpConnection(path, "round42", (message) => sent.push(message));
}

function session(sessionId: string, title = sessionId): SessionState {
  return { sessionId, cwd: "/workspace", createdAt: 10, title };
}

function update(sent: unknown[], index = 0): Record<string, unknown> {
  return sent[index] as Record<string, unknown>;
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Claude ACP adapter round42 内存会话与回调", () => {
  // 初始化只声明协议能力，不创建会话或写入回调消息。
  test("初始化不产生会话或通知", async () => {
    const sent: unknown[] = [];
    const conn = connection(await workspace(), sent);

    const initialized = await conn.initialize();

    expect(initialized.agentCapabilities.sessionCapabilities).toEqual({ list: {}, resume: {} });
    expect((await conn.listSessions({})).sessions).toEqual([]);
    expect(sent).toEqual([]);
  });

  // 自定义标题应逐字保留在新建会话结果中。
  test("新建会话保留自定义标题", async () => {
    const conn = connection(await workspace());

    expect((await conn.newSession({ title: "发布前安全检查" })).title).toBe("发布前安全检查");
  });

  // 缺少标题时使用第一个连续默认标题。
  test("缺少标题使用第一个默认标题", async () => {
    const conn = connection(await workspace());

    expect((await conn.newSession({})).title).toBe("Conversation 1");
  });

  // 空标题不应泄露为空字符串，应回退到默认标题。
  test("空标题回退到默认标题", async () => {
    const conn = connection(await workspace());

    expect((await conn.newSession({ title: "" })).title).toBe("Conversation 1");
  });

  // 创建多个会话时 ID 必须彼此不同。
  test("同一连接的新会话具有唯一标识", async () => {
    const conn = connection(await workspace());
    const first = await conn.newSession({});
    const second = await conn.newSession({});

    expect(first.sessionId).not.toBe(second.sessionId);
  });

  // session/list 保持创建顺序，供客户端稳定渲染会话列表。
  test("会话列表保持创建顺序", async () => {
    const conn = connection(await workspace());
    const first = await conn.newSession({ title: "第一" });
    const second = await conn.newSession({ title: "第二" });

    expect((await conn.listSessions({})).sessions.map((item) => item.sessionId)).toEqual([
      first.sessionId,
      second.sessionId,
    ]);
  });

  // 列表项使用会话创建时间生成合法的 ISO 更新时间。
  test("会话列表包含合法更新时间", async () => {
    const conn = connection(await workspace());
    await conn.newSession({});

    expect(Number.isNaN(Date.parse((await conn.listSessions({})).sessions[0]?.updatedAt ?? ""))).toBe(false);
  });

  // 已知会话可被加载，并返回该会话的工作目录。
  test("加载已知会话返回工作目录", async () => {
    const path = await workspace();
    const conn = connection(path);
    const created = await conn.newSession({});

    expect(await conn.loadSession({ sessionId: created.sessionId })).toMatchObject({
      sessionId: created.sessionId,
      cwd: path,
    });
  });

  // 无活跃会话时加载未知 ID 必须返回空标识而不是伪造请求 ID。
  test("无活跃会话时未知加载返回空标识", async () => {
    const path = await workspace();

    expect(await connection(path).loadSession({ sessionId: "missing" })).toEqual({ sessionId: "", cwd: path });
  });

  // 已有活跃会话时未知加载不能覆盖当前会话。
  test("未知加载保留当前活跃会话", async () => {
    const path = await workspace();
    const conn = connection(path);
    const created = await conn.newSession({});

    expect(await conn.loadSession({ sessionId: "missing" })).toEqual({ sessionId: created.sessionId, cwd: path });
  });

  // 设置合法模式后，后续新会话应回显协商结果。
  test("plan 模式会在新会话中回显", async () => {
    const conn = connection(await workspace());
    await conn.setSessionMode({ modeId: "plan" });

    expect((await conn.newSession({})).modes.currentModeId).toBe("plan");
  });

  // 未声明模式不得覆盖之前已选择的安全模式。
  test("未知模式不覆盖当前模式", async () => {
    const conn = connection(await workspace());
    await conn.setSessionMode({ modeId: "dontAsk" });
    await conn.setSessionMode({ modeId: "untrusted" });

    expect((await conn.newSession({})).modes.currentModeId).toBe("dontAsk");
  });

  // 合法模型选择应持久化为连接级协商状态。
  test("合法模型会在新会话中回显", async () => {
    const conn = connection(await workspace());
    await conn.unstable_setSessionModel({ modelId: "claude-opus-4-8" });

    expect((await conn.newSession({})).models.currentModelId).toBe("claude-opus-4-8");
  });

  // 未知模型不能覆盖现有可用模型选择。
  test("未知模型不覆盖当前模型", async () => {
    const conn = connection(await workspace());
    await conn.unstable_setSessionModel({ modelId: "claude-haiku-4-5-20251001" });
    await conn.unstable_setSessionModel({ modelId: "untrusted-model" });

    expect((await conn.newSession({})).models.currentModelId).toBe("claude-haiku-4-5-20251001");
  });

  // 无会话权限请求要通过 JSON-RPC 通知表达 null 会话上下文。
  test("无会话权限请求发送 null 会话标识", async () => {
    const sent: unknown[] = [];
    const result = await connection(await workspace(), sent).requestPermission({ toolName: "Read", toolArgs: {} });

    expect(result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } });
    expect((update(sent).params as Record<string, unknown>).sessionId).toBeNull();
  });

  // 权限通知原样传递工具名称和参数，避免适配层改变工具调用语义。
  test("权限通知保留工具信息", async () => {
    const sent: unknown[] = [];
    const conn = connection(await workspace(), sent);

    await conn.requestPermission({ toolName: "Write", toolArgs: { file_path: "/safe/note.txt" } });

    const content = ((update(sent).params as Record<string, unknown>).update as Record<string, unknown>)
      .content as Record<string, unknown>;
    expect(content).toMatchObject({ toolName: "Write", toolArgs: { file_path: "/safe/note.txt" } });
  });

  // 加载会话后权限回调必须定位到所加载的会话。
  test("权限通知跟随已加载会话", async () => {
    const sent: unknown[] = [];
    const conn = connection(await workspace(), sent);
    const first = await conn.newSession({});
    await conn.newSession({});
    await conn.loadSession({ sessionId: first.sessionId });

    await conn.requestPermission({ toolName: "Bash", toolArgs: { command: "pwd" } });

    expect((update(sent).params as Record<string, unknown>).sessionId).toBe(first.sessionId);
  });

  // 发送通知的回调错误必须传回调用方，避免无声丢失权限请求。
  test("权限通知回调错误会向调用方抛出", async () => {
    const conn = createClaudeAcpConnection(await workspace(), "round42", () => {
      throw new Error("memory callback failed");
    });

    await expect(conn.requestPermission({ toolName: "Read", toolArgs: {} })).rejects.toThrow("memory callback failed");
  });

  // 空闲连接取消未知会话是幂等操作，不产生额外通知。
  test("取消未知空闲会话不产生通知", async () => {
    const sent: unknown[] = [];
    const conn = connection(await workspace(), sent);

    await expect(conn.cancel({ sessionId: "missing" })).resolves.toBeUndefined();
    expect(sent).toEqual([]);
  });

  // 磁盘中已有 session 元数据会在创建连接时恢复到内存列表。
  test("连接恢复磁盘中的 session 元数据", async () => {
    const path = await workspace();
    const dir = join(path, ".claude", "acp-sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "restored.json"),
      JSON.stringify({ sessionId: "restored", cwd: path, createdAt: 1, title: "恢复" }),
    );

    expect((await connection(path).listSessions({})).sessions).toContainEqual(
      expect.objectContaining({ sessionId: "restored", title: "恢复" }),
    );
  });

  // 旧格式元数据缺少字段时应采用兼容默认值并仍可加载。
  test("恢复旧格式 session 使用兼容默认值", async () => {
    const path = await workspace();
    const dir = join(path, ".claude", "acp-sessions");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "legacy.json"), JSON.stringify({ ccSessionId: "cc-legacy" }));
    const conn = connection(path);

    expect(await conn.loadSession({ sessionId: "legacy" })).toMatchObject({ sessionId: "legacy", cwd: path });
  });

  // 已知请求 ID 优先于活跃会话，确保并发 prompt 路由可独立解析。
  test("prompt 解析优先已知请求会话", () => {
    const sessions = new Map([
      ["active", session("active")],
      ["requested", session("requested")],
    ]);

    expect(resolvePromptTargetSession({ sessionId: "requested" }, sessions, "active").targetSessionId).toBe(
      "requested",
    );
  });

  // 未知请求 ID 应回退到活跃会话 ID，同时不伪造不存在的状态对象。
  test("prompt 解析对未知请求回退活跃会话", () => {
    const sessions = new Map([["active", session("active")]]);

    expect(resolvePromptTargetSession({ sessionId: "missing" }, sessions, "active")).toEqual({
      targetSessionId: "active",
      targetSession: undefined,
    });
  });

  // 没有请求 ID 且不存在活跃会话时，prompt 解析保持空目标。
  test("prompt 解析在无会话时保持空目标", () => {
    expect(resolvePromptTargetSession({}, new Map(), null)).toEqual({
      targetSessionId: null,
      targetSession: undefined,
    });
  });
});
