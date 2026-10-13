import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { createClaudeCodeRuntime } from "../runtime/claude-code-runtime";

/** 用例的最小 LaunchSpec：skills 为空，物化过程不发起下载。 */
function createLaunchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "org-test",
    userId: "user-test",
    environmentId: "env-test",
    agent: { name: "writer", prompt: "请保持准确" },
    model: {
      provider: "provider-test",
      protocol: "anthropic",
      baseUrl: "https://models.example.test",
      apiKey: "test-key",
      model: "test-model",
    },
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

describe("Claude Code runtime relay", () => {
  // relay 应按注册顺序将消息广播给所有监听器，并在取消订阅后停止向该监听器推送。
  test("广播消息并支持取消单个监听器", async () => {
    const relay = await createClaudeCodeRuntime().connectRelay({ instanceId: "instance-1" });
    const receivedByFirst: string[] = [];
    const receivedBySecond: string[] = [];
    const unsubscribeFirst = relay.onMessage?.((message) => receivedByFirst.push(message.type));
    relay.onMessage?.((message) => receivedBySecond.push(message.type));

    relay.send({ type: "first" });
    unsubscribeFirst?.();
    relay.send({ type: "second" });

    expect(relay.state).toBe("open");
    expect(receivedByFirst).toEqual(["first"]);
    expect(receivedBySecond).toEqual(["first", "second"]);
  });

  // 每次连接都应拥有独立监听器集合，避免不同实例的 relay 消息串扰。
  test("隔离不同 relay 的监听器", async () => {
    const runtime = createClaudeCodeRuntime();
    const firstRelay = await runtime.connectRelay({ instanceId: "instance-1" });
    const secondRelay = await runtime.connectRelay({ instanceId: "instance-2" });
    const received: string[] = [];
    firstRelay.onMessage?.((message) => received.push(message.type));

    secondRelay.send({ type: "other-instance" });
    firstRelay.send({ type: "own-instance" });

    expect(received).toEqual(["own-instance"]);
  });
});

describe("Claude Code runtime workspace", () => {
  // 物化必须落在注入根的 {root}/{org}/{user}/{env} 下：旧实现拼相对路径，落点是宿主进程 cwd。
  test("workspace 落在注入的根目录下", async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-code-workspace-"));
    try {
      const runtime = createClaudeCodeRuntime({ workspaceRoot: root });

      await runtime.prepareEnvironment({ instanceId: "inst-workspace", launchSpec: createLaunchSpec() });

      const workspace = join(root, "org-test", "user-test", "env-test");
      await expect(access(join(workspace, ".claude"))).resolves.toBeNull();
      await expect(access(join(workspace, "CLAUDE.md"))).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // 未注入 workspaceRoot 时必须报错：包内没有 cwd 兜底，静默回落会把实例写进宿主进程 cwd。
  test("未注入 workspaceRoot 时拒绝 prepare", async () => {
    const runtime = createClaudeCodeRuntime();

    await expect(
      runtime.prepareEnvironment({ instanceId: "inst-no-root", launchSpec: createLaunchSpec() }),
    ).rejects.toThrow("workspaceRoot");
  });
});
