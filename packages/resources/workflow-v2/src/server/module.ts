/**
 * Workflow V2 资源包组合根。
 *
 * 只承载需要「对象身份」的东西。本包有三处进程级状态，但它们各自都是**服务模块自持的单例**，经冻结 §4
 * 的读取入口取用：上游会话（`getUpstreamSession()`，重复构造等于开两条登录/重登路径）、票据表与撤销表
 * （`iframe-ticket` 模块私有）、本地注册表（`workflow-registry` 经仓储访问）。组合根因此**不再复制一层
 * 转发**——多一层包装只会让「谁是单例持有者」有两个答案（同 `@fenix/resource-memory` 与
 * `@fenix/resource-observer` 的口径：不包装没有消费方的入口）。
 *
 * 唯一的装配期动作是**对账任务（4A）的启停**：它是周期任务，必须随模块装配启动、随模块清理停止，而
 * registry 的 `registerCleanup` 正是这条生命周期的唯一入口（`bootstrapModules` 在装配失败与应用关闭时按
 * 逆序执行登记项）。启动本身不抛错（见 `startReconciliationScheduler`）：读不到模块配置或周期为 `0` 时
 * 只记日志——后台收敛的不可用不该让「模块被启用」变成启动期失败。
 *
 * 装配期纪律：本函数由 registry 的 `create` 工厂调用，**不得抛错**。需要装配期依赖（如授权端口）时，
 * 在此按 `context.modules` 收窄并在这里显式失败。
 */

import type { ModuleFactoryContext } from "@fenix/platform-sdk";
import { startReconciliationScheduler, stopReconciliationScheduler } from "./services/reconciliation";

export interface WorkflowV2ServerModule {
  readonly id: "workflow-v2";
}

/**
 * 创建 Workflow V2 模块实例并接上对账任务的启停。
 *
 * 重复调用（同一进程内两次装配）时 `startReconciliationScheduler` 是幂等的：已排上定时器就直接返回，
 * 不会出现两个定时器各跑一轮。
 */
export function createWorkflowV2ServerModule(context: ModuleFactoryContext): WorkflowV2ServerModule {
  if (startReconciliationScheduler()) context.registerCleanup(() => stopReconciliationScheduler());
  return { id: "workflow-v2" };
}
