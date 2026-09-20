import { getAgentConfigModule, installAgentConfigModule, resetAgentConfigModule } from "./server/runtime";

/**
 * AgentConfig 模块的运行时表面（`fenix.module.ts` 的 `create` 目标）。
 *
 * 与沙盒黄金样本的差别及理由：沙盒的能力全是进程内单例，`createSandboxModule()` 直接返回它们；
 * AgentConfig 的核心能力（Facade、领域服务、关联资源门面、身份目录）需要平台注入——授权能力来自
 * `@fenix/access-control`、身份展示来自 `@fenix/identity`，而 `ModuleFactoryContext` 只提供本模块 env
 * 与已创建模块，无法表达这些构造依赖（同 `packages/platform/access-control/fenix.module.ts` 记录的
 * 同一缺口）。因此这里返回的是**进程级装配结果的入口**而不是自造实例：
 *
 * - 不返回占位/半成品实例——那会形成第二套装配路径，与宿主 `installAgentConfigModule` 的真实装配
 *   互相覆盖；路由与系统入口读到的必须是同一份（`getAgentConfigModule` 是唯一读取点）。
 * - 不复制构造逻辑——真正的组合仍是 `./server/module` 的 `createAgentConfigServerModule`（唯一实现），
 *   由宿主在启动流程中注入依赖后装入；§1.5 的 registry 装配落地时应改为从 `context.modules` 取
 *   access-control / identity 实例并调用它。
 *
 * 路由工厂（`createWebConfigAgentsRoutes` 等）与 `getAgentConfigConfig()` 都是宿主显式调用的入口，
 * 不经过模块实例即可使用，故不在这里重复包装（与 `@fenix/resource-mcp`、`@fenix/resource-skill`
 * 的组合根同口径）。
 */

/** AgentConfig 模块实例：装配结果的读写入口 + registry 索引所需的模块 id。 */
export interface AgentConfigModule {
  readonly id: "agent-config";
  readonly runtime: {
    /** 装入宿主装配结果；测试用同一入口注入替身。 */
    readonly install: typeof installAgentConfigModule;
    /** 读取装配结果；未装配即报错，不兜底。 */
    readonly get: typeof getAgentConfigModule;
    /** 清除装配结果，防止跨测试文件共享状态。 */
    readonly reset: typeof resetAgentConfigModule;
  };
}

/** 创建 AgentConfig 模块实例；`id` 与 `fenix.module.ts` 清单保持一致。 */
export function createAgentConfigModule(): AgentConfigModule {
  return {
    id: "agent-config",
    runtime: {
      install: installAgentConfigModule,
      get: getAgentConfigModule,
      reset: resetAgentConfigModule,
    },
  };
}
