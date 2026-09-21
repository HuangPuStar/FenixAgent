import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { createClaudeCodeRuntime } from "../runtime/claude-code-runtime";

/** 最小 LaunchSpec；workspace 由 organizationId / userId / environmentId 拼出，故用临时目录做根。 */
function createSpec(organizationId: string): AgentLaunchSpec {
  return {
    organizationId,
    userId: "user-test",
    environmentId: "env-test",
    agent: { name: "writer", prompt: "请保持准确" },
    model: {
      provider: "provider-test",
      protocol: "anthropic",
      baseUrl: "https://models.example.test",
      apiKey: "test-key",
      model: "fallback-model",
      modelName: "named-model",
    },
    skills: [],
    mcpServers: [],
  };
}

/** 假 acp-link 子进程：startInstance 只持有引用，不需真实能力。 */
function createFakeProcess(): childProcess.ChildProcess {
  return { killed: false, kill(): void {} } as unknown as childProcess.ChildProcess;
}

afterEach(() => {
  spyOn(childProcess, "spawn").mockRestore();
});

describe("Claude Code runtime spawn 环境白名单", () => {
  // 宿主密钥不得随 acp-link 子进程外传；ACP_ENGINE_TYPE 必须保留以选中 claude-bridge。
  test("spawn acp-link 只传白名单与 ACP_ENGINE_TYPE", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-code-runtime-env-"));
    const previous = { DATABASE_URL: process.env.DATABASE_URL, RCS_API_KEYS: process.env.RCS_API_KEYS };
    process.env.DATABASE_URL = "postgres://host/leak";
    process.env.RCS_API_KEYS = "host-api-keys";
    const options: childProcess.SpawnOptions[] = [];
    spyOn(childProcess, "spawn").mockImplementation((_executable, _args, spawnOptions) => {
      options.push(spawnOptions ?? {});
      return createFakeProcess();
    });

    try {
      const runtime = createClaudeCodeRuntime();
      await runtime.prepareEnvironment({ instanceId: "inst-env", launchSpec: createSpec(root) });
      await runtime.startInstance({ instanceId: "inst-env" });
      const env = options[0]?.env as NodeJS.ProcessEnv;

      expect(options[0]?.cwd).toBe(join(root, "user-test", "env-test"));
      expect(env.ACP_ENGINE_TYPE).toBe("claude-code");
      expect(env).not.toHaveProperty("DATABASE_URL");
      expect(env).not.toHaveProperty("RCS_API_KEYS");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  // acp-link 进程内直读的模型名与 CLI 路径必须由调用点显式下发，否则收窄后静默回退。
  test("显式下发 acp-link 直读的模型名与 CLI 路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-code-runtime-env-"));
    const previous = {
      ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
      CLAUDE_CODE_CLI_PATH: process.env.CLAUDE_CODE_CLI_PATH,
    };
    process.env.ANTHROPIC_MODEL = "host-model";
    delete process.env.CLAUDE_CODE_CLI_PATH;
    const options: childProcess.SpawnOptions[] = [];
    spyOn(childProcess, "spawn").mockImplementation((_executable, _args, spawnOptions) => {
      options.push(spawnOptions ?? {});
      return createFakeProcess();
    });

    try {
      const runtime = createClaudeCodeRuntime();
      await runtime.prepareEnvironment({ instanceId: "inst-model", launchSpec: createSpec(root) });
      await runtime.startInstance({ instanceId: "inst-model" });
      const env = options[0]?.env as NodeJS.ProcessEnv;

      expect(env.ANTHROPIC_MODEL).toBe("host-model");
      // 未定义的键不得以 undefined 混进子进程环境
      expect(env).not.toHaveProperty("CLAUDE_CODE_CLI_PATH");
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
