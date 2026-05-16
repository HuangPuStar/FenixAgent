import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { AcpLinkProcessManager } from "../process/acp-link-process-manager";

class FakeChildProcess extends EventEmitter {
  pid = 4321;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = mock((signal?: NodeJS.Signals | number) => {
    if (signal === "SIGTERM") {
      queueMicrotask(() => this.emit("exit", 0, signal));
    }
    if (signal === "SIGKILL") {
      queueMicrotask(() => this.emit("exit", 0, signal));
    }
    return true;
  });
}

describe("AcpLinkProcessManager", () => {
  // 启动成功
  test("starts acp-link and records pid, port and status", async () => {
    const child = new FakeChildProcess();
    const spawnMock = mock(() => child as unknown as ChildProcess);
    const manager = new AcpLinkProcessManager({
      resolveExecutable: (command) => `/tmp/${command}`,
      spawn: spawnMock as any,
    });

    const started = manager.start({
      instanceId: "inst_start",
      workspace: "/tmp/workspace",
      port: 8888,
      env: { ACP_RCS_TOKEN: "rcs-secret" },
    });
    child.stdout.emit("data", `Token: ${"a".repeat(64)}`);

    await expect(started).resolves.toMatchObject({
      pid: 4321,
      port: 8888,
      status: "running",
    });
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "/tmp/acp-link",
      ["--host", "127.0.0.1", "--port", "8888", "/tmp/opencode", "--", "acp"],
      expect.objectContaining({
        cwd: "/tmp/workspace",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  // token 捕获
  test("captures the local websocket token from stdout", async () => {
    const child = new FakeChildProcess();
    const manager = new AcpLinkProcessManager({
      resolveExecutable: (command) => `/tmp/${command}`,
      spawn: (() => child) as any,
    });

    const started = manager.start({
      instanceId: "inst_token",
      workspace: "/tmp/workspace",
      port: 8889,
    });
    const token = "b".repeat(64);
    child.stdout.emit("data", `ready\nToken: ${token}\n`);

    await expect(started).resolves.toMatchObject({ token });
  });

  // stop 幂等
  test("stops processes idempotently", async () => {
    const child = new FakeChildProcess();
    const manager = new AcpLinkProcessManager({
      resolveExecutable: (command) => `/tmp/${command}`,
      spawn: (() => child) as any,
      stopTimeoutMs: 1,
    });

    const started = manager.start({
      instanceId: "inst_stop",
      workspace: "/tmp/workspace",
      port: 8890,
    });
    child.stdout.emit("data", `Token: ${"c".repeat(64)}`);
    await started;

    await manager.stop("inst_stop");
    await manager.stop("inst_stop");

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
