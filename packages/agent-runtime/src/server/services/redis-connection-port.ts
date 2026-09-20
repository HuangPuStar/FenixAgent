import type { Cluster, Redis } from "ioredis";

/** 宿主 Redis 连接提供者：未配置 `RCS_REDIS_URL` 时返回 null（调用方跳过快照持久化）。 */
export type RedisConnectionProvider = () => Redis | Cluster | null;

/**
 * 宿主提供的 Redis 连接能力（1.4 W2 从 `@server/services/cache` 收敛为端口）。
 *
 * 用途是 YJS 会话快照：会话切换前必须把清空后的 Session Doc 以 CAS 写回 Redis。连接的建立与配置
 * （`RCS_REDIS_URL`、集群模式、重连与超时策略）属宿主 `services/cache`；本包不能自己读环境变量建
 * 连接，否则同一进程会出现第二条互不可见的连接与另一套超时策略，快照写入与宿主其它 Redis 使用点
 * 也会失去统一的关闭路径。
 */
export interface RedisConnectionPort {
  getRedisConnection: RedisConnectionProvider;
}

let redisConnectionPort: RedisConnectionPort | null = null;

/** 由 apps/server 在启动装配阶段绑定宿主的 Redis 连接提供者。 */
export function bindRedisConnectionPort(port: RedisConnectionPort): void {
  redisConnectionPort = port;
}

/**
 * 取已绑定的 Redis 连接。
 *
 * 未装配即失败，不隐式回退为「无 Redis」——后者会让快照持久化静默跳过（会话切换时丢内容），
 * 把装配遗漏伪装成正常的无 Redis 部署。
 */
export function getBoundRedisConnection(): Redis | Cluster | null {
  if (!redisConnectionPort) throw new Error("RedisConnectionPort has not been bound");
  return redisConnectionPort.getRedisConnection();
}

/** 测试用：清空宿主绑定，防止测试进程内状态泄漏。 */
export function resetRedisConnectionPortForTest(): void {
  redisConnectionPort = null;
}
