import { describe, expect, test } from "bun:test";
import type { AcpConnectionAdapter } from "acp-link";
import { adaptOpencodeConnection } from "../runtime/opencode-session-connection";

type Connection = Parameters<AcpConnectionAdapter>[0];

/** 模拟外部 OpenCode 的会话状态；私有字段同时验证适配后 SDK 方法的 this 绑定。 */
class FakeOpencodeConnection {
  #current: string;
  readonly closed = Promise.resolve();
  readonly availableModes = [
    { id: "plan", name: "Plan" },
    { id: "build", name: "Build" },
    { id: "fenix", name: "fenix" },
  ];
  readonly options: { format?: "modes" | "config"; current?: string; failSwitch?: boolean; failLoad?: boolean };

  constructor(options: FakeOpencodeConnection["options"] = {}) {
    this.options = options;
    this.#current = options.current ?? "old-agent";
  }

  /** 返回真实引擎可能使用的两种模式表达，加载本身不修正已删除的 Agent。 */
  async loadSession() {
    if (this.options.failLoad) throw new Error("Session load failed");
    return this.options.format === "config"
      ? {
          configOptions: [
            {
              id: "mode",
              name: "Agent",
              category: "mode",
              type: "select",
              currentValue: this.#current,
              options: this.availableModes.map((mode) => ({ value: mode.id, name: mode.name })),
            },
          ],
        }
      : { modes: { currentModeId: this.#current, availableModes: this.availableModes } };
  }

  /** Resume 使用相同的历史 Agent 状态，但不引入协议方法名兼容。 */
  async resumeSession() {
    return this.loadSession();
  }

  /** 只有显式切换才改变后续 prompt 使用的 Agent。 */
  async setSessionMode({ sessionId, modeId }: { sessionId: string; modeId: string }) {
    if (this.options.failSwitch) throw new Error("Mode switch failed");
    if (sessionId !== "ses-history" || !this.availableModes.some((mode) => mode.id === modeId)) {
      throw new Error("Invalid session or mode");
    }
    this.#current = modeId;
    return {};
  }

  /** 新会话沿用引擎自己的默认选择。 */
  async newSession() {
    this.#current = "fenix";
    return { sessionId: "ses-new" };
  }

  /** 失效 Agent 会拒绝 prompt，与用户反馈保持一致。 */
  async prompt() {
    if (!this.availableModes.some((mode) => mode.id === this.#current)) throw new Error("Agent not found");
    return { stopReason: "end_turn" };
  }
}

function createHarness(options: FakeOpencodeConnection["options"] = {}) {
  const raw = new FakeOpencodeConnection(options);
  const connection = adaptOpencodeConnection(raw as unknown as Connection);
  return { raw, connection };
}

const session = { sessionId: "ses-history", cwd: "/workspace", mcpServers: [] };
const prompt = { sessionId: "ses-history", prompt: [{ type: "text" as const, text: "Continue" }] };

for (const method of ["loadSession", "resumeSession"] as const) {
  describe(`OpenCode ${method}`, () => {
    // 适配必须修正引擎状态，不能仅把响应中的旧名换成新名。
    test.each(["modes", "config"] as const)("恢复 %s 中失效的名称后可继续对话", async (format) => {
      const { connection } = createHarness({ format });
      const restored = await connection[method](session);
      if (format === "modes") expect(restored.modes?.currentModeId).toBe("fenix");
      else expect(restored.configOptions).toMatchObject([{ currentValue: "fenix" }]);
      expect(await connection.prompt(prompt)).toEqual({ stopReason: "end_turn" });
    });

    // 有效的用户模式保持不变，不能强制切回默认 Agent。
    test.each(["plan", "build", "fenix"])("保留有效的 %s 模式", async (current) => {
      const { connection } = createHarness({ current, failSwitch: true });
      expect((await connection[method](session)).modes?.currentModeId).toBe(current);
      expect(await connection.prompt(prompt)).toEqual({ stopReason: "end_turn" });
    });

    // 配置不完整时拒绝恢复，不能任意选择第一个可用模式。
    test("当前 Agent 不在可用列表时拒绝恢复", async () => {
      const { raw, connection } = createHarness();
      raw.availableModes.pop();
      await expect(connection[method](session)).rejects.toThrow("default mode is unavailable");
    });

    // 引擎切换失败必须原样冒泡，不能伪报恢复成功。
    test("暴露模式切换错误", async () => {
      const { connection } = createHarness({ failSwitch: true });
      await expect(connection[method](session)).rejects.toThrow("Mode switch failed");
    });

    // 历史加载失败不能被改名恢复逻辑掩盖。
    test("保留原始加载错误", async () => {
      const { connection } = createHarness({ failLoad: true });
      await expect(connection[method](session)).rejects.toThrow("Session load failed");
    });
  });
}

// 未拦截的方法与属性必须保留 SDK 的上下文和生命周期语义。
test("新会话与连接属性正常透传", async () => {
  const { raw, connection } = createHarness();
  expect(connection.closed).toBe(raw.closed);
  expect(await connection.newSession({ cwd: "/workspace", mcpServers: [] })).toEqual({ sessionId: "ses-new" });
  expect(await connection.prompt(prompt)).toEqual({ stopReason: "end_turn" });
});

// 同一适配器也只能操作传入的连接，不得改写 SDK 原型或其他引擎的连接。
test("修复一个连接不会影响未适配连接", async () => {
  const { connection } = createHarness();
  const other = new FakeOpencodeConnection();
  await connection.loadSession(session);
  expect(await connection.prompt(prompt)).toEqual({ stopReason: "end_turn" });
  await expect(other.prompt()).rejects.toThrow("Agent not found");
});
