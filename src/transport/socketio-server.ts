import { createLogger } from "@fenix/logger";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import { Server as SocketIOServer } from "socket.io";

const logger = createLogger("socketio-server");

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
    const pubClient = new Redis(redisUrl, { lazyConnect: false, retryStrategy: (t) => Math.min(t * 200, 5000) });
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Redis Adapter enabled for cross-node broadcasting");
  } else {
    logger.info("Running in single-node mode (no Redis)");
  }

  return io;
}
