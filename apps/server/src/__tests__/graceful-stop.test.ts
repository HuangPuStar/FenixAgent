import { describe, expect, test } from "bun:test";
import { stopAcceptingRequests } from "../bootstrap/graceful-stop";

describe("宿主有界优雅关闭", () => {
  // 活跃请求在预算内结束时只做一次优雅停止，不触发超时。
  test("预算内完成时保持优雅关闭", async () => {
    let calls = 0;
    const outcome = await stopAcceptingRequests({
      stop: async () => {
        calls++;
      },
      graceMs: 50,
      onTimeout: () => {
        throw new Error("unexpected timeout");
      },
    });
    expect(outcome).toBe("completed");
    expect(calls).toBe(1);
  });

  // 活跃 SSE/WS 超过预算时必须有兜底，但不能二次调用 stop hook。
  test("预算耗尽后只停止一次并报告超时", async () => {
    let calls = 0;
    let timedOut = 0;
    const start = performance.now();
    const outcome = await stopAcceptingRequests({
      stop: async () => {
        calls++;
        await new Promise(() => {});
      },
      graceMs: 20,
      onTimeout: () => {
        timedOut++;
      },
    });
    expect(outcome).toBe("timeout");
    expect(calls).toBe(1);
    expect(timedOut).toBe(1);
    expect(performance.now() - start).toBeLessThan(500);
  });

  // 优雅停止自身失败必须上抛，不能被超时兜底掩盖为成功。
  test("优雅停止失败原样上抛", async () => {
    let calls = 0;
    await expect(
      stopAcceptingRequests({
        stop: async () => {
          calls++;
          throw new Error("stop failed");
        },
        graceMs: 50,
        onTimeout: () => {},
      }),
    ).rejects.toThrow("stop failed");
    expect(calls).toBe(1);
  });
});
