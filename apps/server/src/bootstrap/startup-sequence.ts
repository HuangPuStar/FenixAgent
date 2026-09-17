/** 最小启动阶段依赖，用于保证权限端口在模型网关读取资源前完成装配。 */
export interface CriticalStartupSequenceDependencies {
  initDb: () => Promise<unknown>;
  wirePermissions: () => void;
  initModelGateway: () => Promise<unknown>;
}

/** 按数据库、权限端口、模型网关的依赖顺序执行关键启动阶段。 */
export async function runCriticalStartupSequence(deps: CriticalStartupSequenceDependencies): Promise<void> {
  await deps.initDb();
  deps.wirePermissions();
  await deps.initModelGateway();
}
