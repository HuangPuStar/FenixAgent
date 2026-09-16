import { describe, expect, test } from "bun:test";
import { EnvironmentStartupLock } from "../services/environment-startup-lock";

describe("environment startup lock", () => {
  // 同一环境的并发启动请求只能执行一次，并共享启动结果。
  test("coalesces concurrent startup operations for the same environment", async () => {
    const lock = new EnvironmentStartupLock();
    let executions = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = async () => {
      executions += 1;
      await gate;
      return "instance-1";
    };

    const first = lock.run("env-1", operation);
    const second = lock.run("env-1", operation);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { value: "instance-1", joined: false },
      { value: "instance-1", joined: true },
    ]);
    expect(executions).toBe(1);
  });

  // 启动失败后必须释放锁，后续请求应能够重新发起启动。
  test("releases the lock after a failed startup", async () => {
    const lock = new EnvironmentStartupLock();
    let executions = 0;

    await expect(
      lock.run("env-1", async () => {
        executions += 1;
        throw new Error("startup failed");
      }),
    ).rejects.toThrow("startup failed");

    await expect(
      lock.run("env-1", async () => {
        executions += 1;
        return "instance-2";
      }),
    ).resolves.toEqual({ value: "instance-2", joined: false });
    expect(executions).toBe(2);
  });
});
