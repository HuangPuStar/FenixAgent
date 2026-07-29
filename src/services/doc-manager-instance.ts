// src/services/doc-manager-instance.ts
// 全局 DocManager 单例。所有需要 Y.Doc 生命周期管理的地方统一从这里获取。

import { DocManager } from "@fenix/acp-server";
import { log, error as logError } from "@fenix/logger";
import { getRedisConnection } from "./cache";

export const docManager = new DocManager({
  getRedis: () => getRedisConnection(),
  onLog: (msg) => log(msg),
  onError: (ctx, err) => logError(ctx, err),
});
