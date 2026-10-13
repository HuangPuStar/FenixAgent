import { describe, expect, test } from "bun:test";
import { AcpLinkProcessManager } from "../process/acp-link-process-manager";

function createManager(close: () => Promise<void>) {
  return new AcpLinkProcessManager(undefined, {
    resolveExecutable: (command) => command,
    createServer: () => ({ close }),
  });
}

describe("peri 停止确认", () => {
  // runtime 期望进程存在但 manager 丢失 entry 时必须失败；已知未启动允许幂等停止。
  test("无 entry 时区分不存在和未确认", async () => {
    const manager = createManager(async () => {});
    await expect(manager.stop("absent")).resolves.toBeUndefined();
    await expect(manager.stop("lost", true)).rejects.toThrow("entry is missing");
  });

  // close 未完成不得删除 entry；失败后必须保留句柄重试，成功后重复 stop 幂等。
  test("等待 close 完成，失败保留 entry", async () => {
    let release!: () => void;
    let calls = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const manager = createManager(async () => {
      calls += 1;
      if (calls === 1) throw new Error("exit unconfirmed");
      await gate;
    });
    await manager.start({ instanceId: "instance", workspace: "/tmp", port: 0 });
    await expect(manager.stop("instance", true)).rejects.toThrow("exit unconfirmed");
    let resolved = false;
    const stopping = manager.stop("instance", true).then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    release();
    await stopping;
    await manager.stop("instance");
    expect(calls).toBe(2);
  });
});
