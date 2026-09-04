import { createLogger, interceptConsole } from "@fenix/logger";

// 必须在应用启动前拦截 console，保证全局日志统一。
interceptConsole();

const startupLog = createLogger("rcs");

import type { WebSocketHandler } from "bun";
import { createDefaultApplication } from "./application";
import { applyEnv, config } from "./config";
import { validateEnv } from "./env";

const startedAt = new Date().toISOString();
const env = validateEnv();
applyEnv(env);

const runtime = createDefaultApplication({ env, config, logger: startupLog, startedAt });

try {
  await runtime.start({
    port: config.port,
    hostname: config.host,
    // Elysia 的 Partial<Serve> 类型要求完整 WebSocketHandler，但运行时会与其消息分发器合并。
    websocket: {
      maxPayloadLength: env.RCS_FILE_WS_MAX_PAYLOAD_MB * 1024 * 1024,
    } as unknown as WebSocketHandler<unknown>,
  });
} catch (error) {
  startupLog.error("Application startup failed", toError(error));
  process.exit(1);
}

startupLog.info(
  `Listening on ${config.host}:${config.port} (baseUrl: ${config.baseUrl || `http://localhost:${config.port}`})`,
);

export type App = typeof runtime.app;
export default runtime.app;

let shutdownPromise: Promise<void> | null = null;

function gracefulShutdown(signal: string): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  shutdownPromise = (async () => {
    startupLog.info(`Received ${signal}, shutting down...`);
    try {
      await runtime.stop();
      process.exit(0);
    } catch (error) {
      startupLog.error("Application shutdown failed", toError(error));
      process.exit(1);
    }
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => {
  void gracefulShutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void gracefulShutdown("SIGTERM");
});

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
