import type { CustomNodeRegistry, WorkflowEngine } from "@fenix/workflow-engine";
import { clearAllEngines, getTeamEngine, removeTeamEngine } from "./server/services/workflow";
import { getCustomToolsRegistry, initCustomToolsRegistry } from "./server/services/workflow/custom-tools";

/**
 * Workflow 模块的运行时表面。
 *
 * 只暴露需要「对象身份」的能力：`getTeamEngine()` 按 organizationId 缓存 (engine + transport) 二元组，
 * 引擎内部持有 activeRuns（取消/审批状态）与每 team 一个 StorageAdapter；再构造一个 engine 等于给同一批
 * run 开两条取消/审批路径。因此组合根返回的是包内既有单例，而不是新建一套。
 *
 * 表定义自任务 1.7 B6 起由本包 `db/schema.ts` 提供（出口 `@fenix/resource-workflow/db`）；引擎只是消费方，
 * 句柄经 `getWorkflowDatabase()` 在请求期现取，所以这里不需要 DB 参数。
 *
 * 路由工厂（`createWeb*Routes` / `createApiWorkflowRoutes`）、`handleWebhookRequest` 与
 * `createWorkflowStaticApp` 都要求宿主注入认证守卫，是宿主显式调用的装配入口，不经模块实例即可使用，
 * 故不在这里重复包装。
 */
export interface WorkflowModule {
  readonly id: "workflow";
  /** 按组织取用的工作流引擎单例（惰性创建，进程级缓存）。 */
  readonly engines: {
    get(organizationId: string): WorkflowEngine;
    remove(organizationId: string): boolean;
    /** 清空全部 team 引擎缓存（进程级关闭或测试复位）。 */
    clear(): void;
  };
  /** CustomNode 工具注册表单例：装配期初始化一次，运行期只读。 */
  readonly customTools: {
    init(toolsDir?: string): Promise<CustomNodeRegistry>;
    get(): CustomNodeRegistry;
  };
}

/** 创建 Workflow 模块实例（返回包内既有单例，进程内唯一）。 */
export function createWorkflowModule(): WorkflowModule {
  return {
    id: "workflow",
    engines: {
      get: getTeamEngine,
      remove: removeTeamEngine,
      clear: clearAllEngines,
    },
    customTools: {
      init: initCustomToolsRegistry,
      get: getCustomToolsRegistry,
    },
  };
}
