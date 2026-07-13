import { createLogger } from "@fenix/logger";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server as SocketIOServer } from "socket.io";
import { getRedisClient } from "./store/factory";

const logger = createLogger("socketio-server");

/**
 * 初始化 socket.io server 并附加到 HTTP server。
 *
 * 当配置了 Redis（RCS_REDIS_URL）时，会启用 Redis Adapter 实现跨节点广播。
 * Redis 客户端复用 TransportStore 工厂中的共享连接，避免重复创建连接。
 * 注意：process.env 的值已在应用入口 validateEnv() 中完成校验，此处直接读取即可。
 *
 * @param httpServer - Bun HTTP server 实例（Elysia app.server）
 * @returns socket.io Server 实例
 */
export function initSocketIOServer(httpServer: unknown): SocketIOServer {
  // biome-ignore lint/suspicious/noExplicitAny: Bun server type is not directly compatible with socket.io's TServerInstance
  const io = new SocketIOServer(httpServer as any, {
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
