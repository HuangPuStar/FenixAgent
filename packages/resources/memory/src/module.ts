/**
 * Memory 模块的运行时表面。
 *
 * 本包的服务端能力都是**无状态函数**：记忆开关判定（`shouldEnableAgentMemory`）、记忆库登记
 * （`ensureBank` / `ensureHindsightMcpServer`）、路由工厂与仓储查询都经 `@fenix/resource-memory/server`
 * 直接调用，没有需要「对象身份」的进程级单例（对比 sandbox 的实例锁与 channel 的网关连接）。
 * 因此组合根只承载模块标识，不在这里重复包装纯函数——与 `@fenix/resource-sandbox`、
 * `@fenix/resource-channel` 的组合根同口径：只暴露需要对象身份的能力。
 *
 * 存在的意义是 manifest 的惰性 `create` 工厂需要一个入口：模块索引层只 import 本文件，装配期
 * 再按需加载 `./server` 图。宿主挂载（§1.5 的 `mountContribution`）需要统一拿到路由工厂时，
 * 在这里按需扩展即可。
 */
export interface MemoryModule {
  readonly id: "memory";
}

/** 创建 Memory 模块实例；本包无可变运行期状态，重复调用不产生第二份状态。 */
export function createMemoryModule(): MemoryModule {
  return { id: "memory" };
}
