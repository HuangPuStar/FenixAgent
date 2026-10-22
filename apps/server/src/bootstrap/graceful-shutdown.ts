import { stopAcceptingRequests } from "./graceful-stop";

interface ShutdownLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

/** 组装可测试的有界关闭流程：停止入口、宿主清理、遥测刷新、显式退出。 */
export function createGracefulShutdown(options: {
  readonly stop: () => Promise<void>;
  readonly shutdownHost: () => Promise<void>;
  readonly shutdownTelemetry: () => Promise<void>;
  readonly graceMs: number;
  readonly logger: ShutdownLogger;
  readonly exit: (code: number) => void;
}): (signal: string) => Promise<void> {
  let shutdown: Promise<void> | undefined;
  const run = async (signal: string): Promise<void> => {
    let exitCode = 0;
    options.logger.info(`Received ${signal}, shutting down...`);
    try {
      // 超时后不重复调用 stop：Elysia 的 stop hook 只能执行一次，进程退出会关闭剩余连接。
      await stopAcceptingRequests({
        stop: options.stop,
        graceMs: options.graceMs,
        onTimeout: () => options.logger.warn(`请求排空超过 ${options.graceMs}ms，完成清理后退出`),
      });
    } catch (error) {
      exitCode = 1;
      options.logger.error("停止接收请求失败", error);
    }
    try {
      await options.shutdownHost();
    } catch (error) {
      exitCode = 1;
      options.logger.error("宿主清理失败", error);
    }
    try {
      await options.shutdownTelemetry();
    } catch (error) {
      exitCode = 1;
      options.logger.error("遥测刷新失败", error);
    }
    options.logger.info("宿主资源清理结束");
    options.exit(exitCode);
  };
  return (signal) => {
    shutdown ??= run(signal);
    return shutdown;
  };
}
