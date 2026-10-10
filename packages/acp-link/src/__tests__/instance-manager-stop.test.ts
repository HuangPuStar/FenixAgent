import { expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { InstanceManager } from "../client/instance-manager.js";

// 世代不匹配不能误停新进程或伪报成功；匹配后必须等 EOF 引起的退出，允许重复停止。
test("远程 stop 校验 fence 并等待进程退出", async () => {
  const root = await mkdtemp(join(tmpdir(), "instance-stop-"));
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null,
    kill: () => {
      throw new Error("unexpected signal");
    },
  }) as unknown as ChildProcess;
  let cleanups = 0;
  const manager = new InstanceManager(
    {
      peri: {
        async prepareWorkspace() {},
        async startInstance({ state }) {
          state.process = child;
          return { capabilities: {} };
        },
        async stopInstance() {
          cleanups += 1;
        },
      },
    },
    root,
  );
  const spec: AgentLaunchSpec = {
    organizationId: "org",
    userId: "user",
    env: {},
    agent: { name: "agent", prompt: "" },
    model: { provider: "test", protocol: "openai", model: "test" },
    skills: [],
    mcpServers: [],
  };
  try {
    await manager.prepare("instance", spec, "peri", 2, "epoch");
    await manager.start("instance", () => {});
    await expect(manager.stop("instance", 1, "epoch")).rejects.toThrow("fence mismatch");
    await expect(manager.stop("instance", 2, "stale-epoch")).rejects.toThrow("fence mismatch");
    expect(child.stdin?.writableEnded).toBe(false);
    const stopping = manager.stop("instance", 2, "epoch");
    await Promise.resolve();
    expect(child.stdin?.writableEnded).toBe(true);
    expect(manager.hasInstance("instance")).toBe(true);
    expect(cleanups).toBe(0);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopping;
    await manager.stop("instance", 2, "epoch");
    expect(manager.hasInstance("instance")).toBe(false);
    expect(cleanups).toBe(1);
  } finally {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await manager.stop("instance");
    await rm(root, { recursive: true, force: true });
  }
});
