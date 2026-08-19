import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeAcpConnection } from "../client/claude-acp-adapter";

const workspaces: string[] = [];

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "claude-adapter-round64-"));
  workspaces.push(path);
  return path;
}

function connection(path: string, sent: unknown[] = [], modelName?: string) {
  return createClaudeAcpConnection(path, "round64", (message) => sent.push(message), undefined, modelName);
}

function sessionsDirectory(path: string): string {
  return join(path, ".claude", "acp-sessions");
}

async function writeSession(path: string, filename: string, value: unknown): Promise<void> {
  const directory = sessionsDirectory(path);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, filename), JSON.stringify(value));
}

async function waitForFile(path: string): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await Bun.sleep(5);
    }
  }
  throw new Error(`会话元数据未写入: ${path}`);
}

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("Claude ACP adapter round64 持久化与恢复边界", () => {
  // 缺少持久化目录时，连接应以空会话列表正常启动。
  test("不存在会话目录时返回空列表", async () => {
    expect((await connection(await workspace()).listSessions({})).sessions).toEqual([]);
  });

  // 非 JSON 辅助文件不能被误识别为可恢复会话。
  test("恢复时忽略非 JSON 文件", async () => {
    const path = await workspace();
    const directory = sessionsDirectory(path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "notes.txt"), "不是会话");

    expect((await connection(path).listSessions({})).sessions).toEqual([]);
  });

  // 损坏的 JSON 元数据必须被隔离，不能阻断其余连接能力。
  test("恢复时忽略损坏的 JSON 元数据", async () => {
    const path = await workspace();
    const directory = sessionsDirectory(path);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "broken.json"), "{");

    expect((await connection(path).listSessions({})).sessions).toEqual([]);
  });

  // 有效元数据与损坏元数据并存时，仅恢复有效会话。
  test("损坏元数据不影响有效会话恢复", async () => {
    const path = await workspace();
    await writeSession(path, "valid.json", { sessionId: "valid", cwd: path, createdAt: 1, title: "有效" });
    await mkdir(sessionsDirectory(path), { recursive: true });
    await writeFile(join(sessionsDirectory(path), "broken.json"), "[");

    expect((await connection(path).listSessions({})).sessions).toEqual([
      expect.objectContaining({ sessionId: "valid", title: "有效" }),
    ]);
  });

  // JSON 内的 sessionId 是权威标识，兼容历史迁移后的文件名变更。
  test("恢复优先采用 JSON 内的会话标识", async () => {
    const path = await workspace();
    await writeSession(path, "old-name.json", { sessionId: "canonical", cwd: path, createdAt: 1, title: "迁移" });

    expect(await connection(path).loadSession({ sessionId: "canonical" })).toMatchObject({
      sessionId: "canonical",
      cwd: path,
    });
  });

  // 旧文件缺少 sessionId 时，文件名应成为稳定的兼容标识。
  test("恢复缺少会话标识的旧文件时使用文件名", async () => {
    const path = await workspace();
    await writeSession(path, "legacy-id.json", { cwd: path, createdAt: 1, title: "旧会话" });

    expect(await connection(path).loadSession({ sessionId: "legacy-id" })).toMatchObject({
      sessionId: "legacy-id",
      cwd: path,
    });
  });

  // 旧文件缺少 cwd 时必须回退到当前 workspace，避免返回空路径。
  test("恢复缺少工作目录的旧文件时使用当前目录", async () => {
    const path = await workspace();
    await writeSession(path, "missing-cwd.json", { sessionId: "missing-cwd", createdAt: 1, title: "旧会话" });

    expect(await connection(path).loadSession({ sessionId: "missing-cwd" })).toMatchObject({ cwd: path });
  });

  // 旧文件缺少标题时必须生成可展示的兼容标题。
  test("恢复缺少标题的旧文件时生成默认标题", async () => {
    const path = await workspace();
    await writeSession(path, "title-fallback.json", { sessionId: "title-fallback", cwd: path, createdAt: 1 });

    expect((await connection(path).listSessions({})).sessions[0]?.title).toBe("Conversation back");
  });

  // 无创建时间的旧元数据仍要产生合法的列表时间戳。
  test("恢复缺少创建时间的旧文件时生成合法更新时间", async () => {
    const path = await workspace();
    await writeSession(path, "time-fallback.json", { sessionId: "time-fallback", cwd: path, title: "时间" });

    const updatedAt = (await connection(path).listSessions({})).sessions[0]?.updatedAt ?? "";
    expect(Number.isNaN(Date.parse(updatedAt))).toBe(false);
  });

  // 多份有效持久化元数据都应进入内存会话映射。
  test("恢复多个持久化会话", async () => {
    const path = await workspace();
    await writeSession(path, "one.json", { sessionId: "one", cwd: path, createdAt: 1, title: "一" });
    await writeSession(path, "two.json", { sessionId: "two", cwd: path, createdAt: 2, title: "二" });

    expect((await connection(path).listSessions({})).sessions.map((item) => item.sessionId).sort()).toEqual([
      "one",
      "two",
    ]);
  });

  // 会话元数据被删除后，新连接不能恢复已删除会话。
  test("删除会话元数据后不再恢复", async () => {
    const path = await workspace();
    await writeSession(path, "deleted.json", { sessionId: "deleted", cwd: path, createdAt: 1, title: "已删除" });
    await rm(join(sessionsDirectory(path), "deleted.json"));

    expect((await connection(path).listSessions({})).sessions).toEqual([]);
  });

  // 目录路径本身异常时，恢复逻辑必须降级为空列表而非抛错。
  test("会话目录被普通文件占用时恢复为空列表", async () => {
    const path = await workspace();
    await mkdir(join(path, ".claude"), { recursive: true });
    await writeFile(sessionsDirectory(path), "阻止读取目录");

    expect((await connection(path).listSessions({})).sessions).toEqual([]);
  });

  // 创建会话后应将用户标题写入真实持久化元数据。
  test("新会话将标题持久化到磁盘", async () => {
    const path = await workspace();
    const created = await connection(path).newSession({ title: "持久化标题" });
    const data = JSON.parse(await waitForFile(join(sessionsDirectory(path), `${created.sessionId}.json`))) as Record<
      string,
      unknown
    >;

    expect(data).toMatchObject({ sessionId: created.sessionId, cwd: path, title: "持久化标题" });
  });

  // 持久化格式应记录更新时间，供后续版本识别元数据新鲜度。
  test("新会话持久化元数据包含更新时间", async () => {
    const path = await workspace();
    const created = await connection(path).newSession({});
    const data = JSON.parse(await waitForFile(join(sessionsDirectory(path), `${created.sessionId}.json`))) as Record<
      string,
      unknown
    >;

    expect(data.updatedAt).toBeTypeOf("number");
  });

  // 无法创建元数据目录时，内存会话生命周期仍然可用。
  test("持久化失败不阻断新会话", async () => {
    const path = await workspace();
    await writeFile(join(path, ".claude"), "不是目录");
    const conn = connection(path);
    const created = await conn.newSession({ title: "内存继续" });

    expect((await conn.loadSession({ sessionId: created.sessionId })).sessionId).toBe(created.sessionId);
  });

  // 恢复的已知会话可成为 active session，供后续无目标请求安全回退。
  test("加载恢复会话后未知加载保留该活跃会话", async () => {
    const path = await workspace();
    await writeSession(path, "restored.json", { sessionId: "restored", cwd: path, createdAt: 1, title: "恢复" });
    const conn = connection(path);
    await conn.loadSession({ sessionId: "restored" });

    expect(await conn.loadSession({ sessionId: "missing" })).toEqual({ sessionId: "restored", cwd: path });
  });

  // 没有 CC session UUID 的恢复请求不得产生历史回放通知。
  test("恢复没有 CC 标识的会话不发送通知", async () => {
    const path = await workspace();
    const sent: unknown[] = [];
    await writeSession(path, "plain.json", { sessionId: "plain", cwd: path, createdAt: 1, title: "普通" });

    const resumed = await connection(path, sent).unstable_resumeSession({ sessionId: "plain" });
    expect(resumed.sessionId).toBe("plain");
    expect(sent).toEqual([]);
  });

  // 未知恢复请求不能伪造会话，应返回空标识及当前协商能力。
  test("恢复未知会话返回空标识和协商能力", async () => {
    const resumed = await connection(await workspace()).unstable_resumeSession({ sessionId: "missing" });

    expect(resumed).toMatchObject({
      sessionId: "",
      models: { currentModelId: "claude-sonnet-4-6" },
      modes: { currentModeId: "acceptEdits" },
    });
  });

  // 空恢复参数同样不能创建隐式会话。
  test("恢复缺少会话标识时保持空会话", async () => {
    const conn = connection(await workspace());

    expect((await conn.unstable_resumeSession({})).sessionId).toBe("");
    expect((await conn.listSessions({})).sessions).toEqual([]);
  });

  // 恢复会话后权限回调必须绑定该会话，不能丢失恢复上下文。
  test("恢复会话后的权限通知绑定恢复标识", async () => {
    const path = await workspace();
    const sent: unknown[] = [];
    await writeSession(path, "permission.json", { sessionId: "permission", cwd: path, createdAt: 1, title: "权限" });
    const conn = connection(path, sent);
    await conn.unstable_resumeSession({ sessionId: "permission" });
    await conn.requestPermission({ toolName: "Read", toolArgs: {} });

    expect(sent[0]).toMatchObject({ params: { sessionId: "permission" } });
  });

  // 显式构造参数应优先于环境默认模型，避免进程环境覆盖实例配置。
  test("显式模型优先于环境模型", async () => {
    const previous = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "environment-model";
    try {
      expect((await connection(await workspace(), [], "explicit-model").newSession({})).models.currentModelId).toBe(
        "explicit-model",
      );
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = previous;
    }
  });

  // 环境模型应成为未显式配置连接的初始模型并出现在可选模型中。
  test("环境模型成为默认模型并可选择", async () => {
    const previous = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "environment-model";
    try {
      const conn = connection(await workspace());
      const created = await conn.newSession({});
      await conn.unstable_setSessionModel({ modelId: "environment-model" });

      expect(created.models.currentModelId).toBe("environment-model");
      expect((await conn.newSession({})).models.currentModelId).toBe("environment-model");
    } finally {
      if (previous === undefined) delete process.env.ANTHROPIC_MODEL;
      else process.env.ANTHROPIC_MODEL = previous;
    }
  });

  // 空白标题是有效用户输入，不应被适配层擅自裁剪或改写。
  test("空白标题按原样保留", async () => {
    expect((await connection(await workspace()).newSession({ title: "   " })).title).toBe("   ");
  });
});
