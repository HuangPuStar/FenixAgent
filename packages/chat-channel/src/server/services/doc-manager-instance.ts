// 全局 DocManager 单例。所有需要 Y.Doc 生命周期管理的宿主统一从这里获取。

import { log, error as logError } from "@fenix/logger";
import { getRedisConnection } from "../../../../../apps/server/src/services/cache";
import { DocManager } from "../../state/doc-manager";

export const docManager = new DocManager({
  getRedis: () => getRedisConnection(),
  onLog: (msg) => log(msg),
  onError: (ctx, err) => logError(ctx, err),
});
