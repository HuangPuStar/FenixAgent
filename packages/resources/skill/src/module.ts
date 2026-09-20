import { getSkillServerModule, installSkillServerModule, resetSkillServerModule } from "./server/runtime";

/**
 * Skill 模块的运行时表面（`fenix.module.ts` 的 `create` 目标）。
 *
 * 与沙盒黄金样本的差别及理由：沙盒的能力全是进程内单例，`createSandboxModule()` 直接返回它们；
 * Skill 的能力需要平台注入（授权、查询端口、身份目录），装配结果按进程唯一——路由、系统路径
 * （builtin 同步）与 launch spec 都在调用时读同一份。因此这里做两件事而不复制构造逻辑：
 *
 * 1. 给模块实例补上 registry 需要的 `id`（与 `fenix.module.ts` 清单同值）；
 * 2. 把装配生命周期（install / get / reset）从 `./server/runtime` 转出，供 §1.5 的 registry 装配
 *    在单处取用。
 *
 * 真正的构造实现在 `./server/module`（`createSkillServerModule`）——保持唯一，避免出现第二套组装
 * 顺序（授权端口、身份目录与资源注册的绑定关系只允许有一处定义）。
 *
 * 路由工厂与 `SkillModuleConfig` 读取是宿主显式调用的入口，不经过模块实例即可使用，故不在这里
 * 重复包装；等 registry 驱动的装配落地（§1.5 的 `mountContribution`）需要统一拿到它们时再按需
 * 扩展（与 `@fenix/resource-channel` 的组合根同口径）。
 */
export interface SkillModule {
  readonly id: "skill";
  /** 进程级装配结果：宿主装配期 `install`，运行期各调用点 `get`，测试 `reset` 防状态泄漏。 */
  readonly runtime: {
    readonly install: typeof installSkillServerModule;
    readonly get: typeof getSkillServerModule;
    readonly reset: typeof resetSkillServerModule;
  };
}

/** 创建 Skill 模块实例；返回的是包内既有单例的入口，不产生第二份运行期状态。 */
export function createSkillModule(): SkillModule {
  return {
    id: "skill",
    runtime: {
      install: installSkillServerModule,
      get: getSkillServerModule,
      reset: resetSkillServerModule,
    },
  };
}
