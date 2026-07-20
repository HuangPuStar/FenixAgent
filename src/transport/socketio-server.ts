import { createLogger } from "@fenix/logger";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server as SocketIOServer } from "socket.io";
import { getRedisClient } from "./store/factory";

const logger = createLogger("socketio-server");

/**
 * 初始化 socket.io server。
 *
 * @param httpServer - Bun HTTP server 实例（可选）。为 `undefined` 时创建无 server 的实例，稍后通过 `io.attach()` 绑定。
 * @returns socket.io Server 实例
 */
export function initSocketIOServer(httpServer?: unknown): SocketIOServer {
  // biome-ignore lint/suspicious/noExplicitAny: Bun server type 与 socket.io TServerInstance 不兼容
  const io = httpServer
    ? new SocketIOServer(httpServer as any, {
        path: "/socket.io/",
        cors: { origin: true, credentials: true },
        connectTimeout: 10000,
        transports: ["websocket"],
      })
    : new SocketIOServer({
        path: "/socket.io/",
        cors: { origin: true, credentials: true },
        connectTimeout: 10000,
        transports: ["websocket"],
      });

  const redisUrl = process.env.RCS_REDIS_URL;

  if (redisUrl) {
    // 尝试复用 TransportStore 的共享 Redis 客户端，避免创建双倍连接
    let pubClient: Redis;
    let subClient: Redis;

    const sharedClient = getRedisClient();
    if (sharedClient) {
      pubClient = sharedClient;
      subClient = sharedClient.duplicate();
    } else {
      pubClient = new Redis(redisUrl, { lazyConnect: false, retryStrategy: (t) => Math.min(t * 200, 5000) });
      subClient = pubClient.duplicate();
    }

    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Redis Adapter enabled for cross-node broadcasting");
  } else {
    logger.info("Running in single-node mode (no Redis)");
  }

  return io;
}
