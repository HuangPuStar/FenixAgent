import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { stopAgentProcess } from "../stop-agent-process.js";

function createChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
  }) as unknown as ChildProcess;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  return { child, signals };
}

function exit(child: ChildProcess) {
  child.exitCode = 0;
  child.emit("exit", 0, null);
}

describe("Agent EOF 停止", () => {
  // 写入 EOF 不等于退出；并发调用应共享确认结果，退出后重复停止不再发送信号。
  test("关闭 stdin 后等待 exit，重复停止幂等", async () => {
    const { child, signals } = createChild();
    let resolved = false;
    const stop = stopAgentProcess(child);
    expect(stopAgentProcess(child)).toBe(stop);
    void stop.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(child.stdin?.writableEnded).toBe(true);
    expect(resolved).toBe(false);
    exit(child);
    expect(await stop).toBe("graceful");
    expect(await stopAgentProcess(child)).toBe("exited");
    expect(signals).toEqual([]);
    expect(child.listenerCount("exit")).toBe(0);
  });

  // 可注入阶段等待，确定性覆盖 EOF、TERM、KILL 的升级顺序而不依赖 sleep。
  test("drain 和 TERM 超时后 KILL，确认退出才成功", async () => {
    const { child, signals } = createChild();
    const deadlines: number[] = [];
    const result = await stopAgentProcess(child, {
      waitForExit: async (_child, timeout) => {
        deadlines.push(timeout);
        expect(child.stdin?.writableEnded).toBe(true);
        if (signals.length === 2) exit(child);
        return child.exitCode !== null;
      },
    });
    expect(result).toBe("sigkill");
    expect(deadlines).toEqual([10_000, 2_000, 2_000]);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  // kill 返回 true 只表示信号已发送，不能让 strict stop 把未知进程误标为停止。
  test("SIGKILL 后仍未确认退出则拒绝，后续可重试", async () => {
    const { child, signals } = createChild();
    await expect(stopAgentProcess(child, { waitForExit: async () => false })).rejects.toThrow(
      "exit could not be confirmed",
    );
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    exit(child);
    expect(await stopAgentProcess(child)).toBe("exited");
  });

  // 已被信号终止时 exitCode 为 null，应以 signalCode 确认而非 killed 标记。
  test("signalCode 表示已退出，不再发信号", async () => {
    const { child, signals } = createChild();
    child.signalCode = "SIGTERM";
    expect(await stopAgentProcess(child)).toBe("exited");
    expect(signals).toEqual([]);
  });
});
