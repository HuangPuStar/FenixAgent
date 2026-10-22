import { describe, expect, test } from "bun:test";
import { createGracefulShutdown } from "../bootstrap/graceful-shutdown";

const silentLogger = { info() {}, warn() {}, error() {} };

describe("宿主关闭控制器", () => {
  // 正常路径按停止入口、宿主、遥测、退出顺序执行一次。
  test("清理顺序正确且退出码为 0", async () => {
    const calls: string[] = [];
    const codes: number[] = [];
    const shutdown = createGracefulShutdown({
      stop: async () => {
        calls.push("stop");
      },
      shutdownHost: async () => {
        calls.push("host");
      },
      shutdownTelemetry: async () => {
        calls.push("telemetry");
      },
      graceMs: 50,
      logger: silentLogger,
      exit: (code) => {
        calls.push("exit");
        codes.push(code);
      },
    });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["stop", "host", "telemetry", "exit"]);
    expect(codes).toEqual([0]);
  });

  // 请求排空超时后只调用一次 stop，宿主清理和退出必须继续。
  test("排空超时不再二次 stop 且仍完成清理", async () => {
    let stopCalls = 0;
    let hostCalls = 0;
    let telemetryCalls = 0;
    const codes: number[] = [];
    const shutdown = createGracefulShutdown({
      stop: async () => {
        stopCalls++;
        await new Promise(() => {});
      },
      shutdownHost: async () => {
        hostCalls++;
      },
      shutdownTelemetry: async () => {
        telemetryCalls++;
      },
      graceMs: 20,
      logger: silentLogger,
      exit: (code) => codes.push(code),
    });
    await shutdown("SIGTERM");
    expect({ stopCalls, hostCalls, telemetryCalls, codes }).toEqual({
      stopCalls: 1,
      hostCalls: 1,
      telemetryCalls: 1,
      codes: [0],
    });
  });

  // stop 抛错不能跳过宿主清理，退出码必须反映失败。
  test("stop 失败仍执行宿主清理并退出 1", async () => {
    let hostCalls = 0;
    let telemetryCalls = 0;
    const codes: number[] = [];
    const shutdown = createGracefulShutdown({
      stop: async () => {
        throw new Error("stop failed");
      },
      shutdownHost: async () => {
        hostCalls++;
      },
      shutdownTelemetry: async () => {
        telemetryCalls++;
      },
      graceMs: 50,
      logger: silentLogger,
      exit: (code) => codes.push(code),
    });
    await shutdown("SIGTERM");
    expect({ hostCalls, telemetryCalls, codes }).toEqual({ hostCalls: 1, telemetryCalls: 1, codes: [1] });
  });

  // 宿主清理失败后仍刷新遥测并退出非 0。
  test("宿主清理失败仍刷新遥测并退出 1", async () => {
    let telemetryCalls = 0;
    const codes: number[] = [];
    const shutdown = createGracefulShutdown({
      stop: async () => {},
      shutdownHost: async () => {
        throw new Error("host failed");
      },
      shutdownTelemetry: async () => {
        telemetryCalls++;
      },
      graceMs: 50,
      logger: silentLogger,
      exit: (code) => codes.push(code),
    });
    await shutdown("SIGTERM");
    expect({ telemetryCalls, codes }).toEqual({ telemetryCalls: 1, codes: [1] });
  });

  // 并发/重复信号共享同一关闭流程，stop 和 exit 都只执行一次。
  test("重复信号幂等", async () => {
    let stopCalls = 0;
    let exitCalls = 0;
    const shutdown = createGracefulShutdown({
      stop: async () => {
        stopCalls++;
      },
      shutdownHost: async () => {},
      shutdownTelemetry: async () => {},
      graceMs: 50,
      logger: silentLogger,
      exit: () => {
        exitCalls++;
      },
    });
    await Promise.all([shutdown("SIGINT"), shutdown("SIGTERM")]);
    expect({ stopCalls, exitCalls }).toEqual({ stopCalls: 1, exitCalls: 1 });
  });
});
