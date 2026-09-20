import { getMcpServerModule, installMcpServerModule, resetMcpServerModule } from "./server/runtime";

/**
 * MCP 模块的运行时表面（`fenix.module.ts` 的 `create` 目标）。
 *
 * 与沙盒黄金样本的差别及理由：沙盒的能力（provider 注册表、实例管理器、执行入口）都是不需要注入的
 * 进程内单例，`createSandboxModule()` 直接返回它们；MCP 的能力需要平台注入（授权、查询端口、身份
 * 目录），`ModuleFactoryContext` 目前只提供本模块 env 与已创建模块，无法表达这四项目标
 * （同 `packages/platform/access-control/fenix.module.ts` 记录的同一缺口）。因此这里返回的是
 * **进程级装配结果的入口**而不是自造实例：
 *
 * - 不返回占位/半成品实例——那会形成第二套装配路径，与宿主 `installMcpServerModule` 的真实装配
 *   互相覆盖；
 * - 不复制构造逻辑——真正的组合仍是 `./server/module` 的 `createMcpServerServerModule`（唯一实现），
 *   由宿主在启动流程中注入依赖后装入；§1.5 的 registry 装配落地时应改为从 `context.modules` 取
 *   access-control / identity 实例并调用它。
 *
 * 路由工厂不在模块实例上重复包装：它们是宿主显式调用的入口，不需要对象身份。
 */

/** MCP 模块实例：装配结果的读写入口 + registry 索引所需的模块 id。 */
export interface McpModule {
  readonly id: "mcp";
  readonly runtime: {
    /** 装入宿主装配结果；测试用同一入口注入替身。 */
    readonly install: typeof installMcpServerModule;
    /** 读取装配结果；未装配即报错，不兜底。 */
    readonly get: typeof getMcpServerModule;
    /** 清除装配结果，防止跨测试文件共享状态。 */
    readonly reset: typeof resetMcpServerModule;
  };
}

/** 创建 MCP 模块实例；`id` 与 `fenix.module.ts` 清单保持一致。 */
export function createMcpModule(): McpModule {
  return {
    id: "mcp",
    runtime: {
      install: installMcpServerModule,
      get: getMcpServerModule,
      reset: resetMcpServerModule,
    },
  };
}
