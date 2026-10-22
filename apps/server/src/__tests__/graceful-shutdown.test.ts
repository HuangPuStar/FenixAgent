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
      logger: {
        info: (message) => {
          if (message === "宿主资源清理结束") calls.push("cleanup-log");
        },
        warn() {},
        error() {},
      },
      exit: (code) => {
        calls.push("exit");
        codes.push(code);
      },
    });
    await shutdown("SIGTERM");
    expect(calls).toEqual(["stop", "host", "cleanup-log", "telemetry", "exit"]);
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

  // 宿主清理失败后仍先写最后一条日志、再刷新遥测，并退出非 0。
  test("宿主清理失败仍刷新遥测并退出 1", async () => {
    const calls: string[] = [];
    const codes: number[] = [];
    const shutdown = createGracefulShutdown({
      stop: async () => {},
      shutdownHost: async () => {
        throw new Error("host failed");
      },
      shutdownTelemetry: async () => {
        calls.push("telemetry");
      },
      graceMs: 50,
      logger: {
        info: (message) => {
          if (message === "宿主资源清理结束") calls.push("cleanup-log");
        },
        warn() {},
        error() {},
      },
      exit: (code) => codes.push(code),
    });
    await shutdown("SIGTERM");
    expect({ calls, codes }).toEqual({ calls: ["cleanup-log", "telemetry"], codes: [1] });
  });

  // 遥测刷新失败仍会执行显式退出，并用退出码 1 暴露失败。
  test("遥测刷新失败退出 1", async () => {
    const codes: number[] = [];
    const errors: string[] = [];
    const shutdown = createGracefulShutdown({
      stop: async () => {},
      shutdownHost: async () => {},
      shutdownTelemetry: async () => {
        throw new Error("telemetry failed");
      },
      graceMs: 50,
      logger: {
        info() {},
        warn() {},
        error: (message) => errors.push(message),
      },
      exit: (code) => codes.push(code),
    });
    await shutdown("SIGTERM");
    expect({ codes, errors }).toEqual({ codes: [1], errors: ["遥测刷新失败"] });
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
