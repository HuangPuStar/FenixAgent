import { describe, expect, test } from "bun:test";
import { AcpLinkProcessManager } from "../process/acp-link-process-manager";

describe("AcpLinkProcessManager", () => {
  // 启动成功：直接在进程内创建 acp server
  test("starts acp server in-process and records port", async () => {
    const manager = new AcpLinkProcessManager({
      resolveExecutable: (command) => `/tmp/${command}`,
    });

    const started = await manager.start({
      instanceId: "inst_start",
      workspace: "/tmp/workspace",
      port: 0, // 使用 port 0 会让系统分配可用端口
    });

    expect(started).toMatchObject({
      port: expect.any(Number),
      status: "running",
    });

    // 清理
    await manager.stop("inst_start");
  });

  // stop 幂等
  test("stops server idempotently", async () => {
    const manager = new AcpLinkProcessManager({
      resolveExecutable: (command) => `/tmp/${command}`,
    });

    await manager.start({
      instanceId: "inst_stop",
      workspace: "/tmp/workspace",
      port: 0,
    });

    await manager.stop("inst_stop");
    await manager.stop("inst_stop"); // 第二次应该无操作
  });
});
