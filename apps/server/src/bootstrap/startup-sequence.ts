/** 最小启动阶段依赖，用于保证权限端口在模型网关读取资源前完成装配。 */
export interface CriticalStartupSequenceDependencies {
  initDb: () => Promise<unknown>;
  /** 模块装配：1.5f 起由 registry 的 `bootstrapServerAssembly()` 承担（含路由贡献构造），故是异步的。 */
  wirePermissions: () => Promise<unknown>;
  initModelGateway: () => Promise<unknown>;
}

/** 按数据库、模块装配、模型网关的依赖顺序执行关键启动阶段。 */
export async function runCriticalStartupSequence(deps: CriticalStartupSequenceDependencies): Promise<void> {
  await deps.initDb();
  await deps.wirePermissions();
  await deps.initModelGateway();
}
