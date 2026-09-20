// 全局 DocManager 单例。所有需要 Y.Doc 生命周期管理的宿主统一从这里获取。

import { log, error as logError } from "@fenix/logger";
import { getRedisConnection } from "@fenix/platform-sdk/server";
import type { Cluster, Redis } from "ioredis";
import { DocManager } from "../../state/doc-manager";

export const docManager = new DocManager({
  // Redis 连接是宿主声明的进程能力（`initializeApplicationInfrastructure` 的 `redisConnection`），
  // 本包不读环境变量、不建连：未声明或宿主尚未建连时得到 null，DocManager 据此跳过快照持久化，
  // 与 agent-runtime 的会话切换快照走同一个取数点。
  getRedis: () => getRedisConnection<Redis | Cluster>(),
  onLog: (msg) => log(msg),
  onError: (ctx, err) => logError(ctx, err),
});
