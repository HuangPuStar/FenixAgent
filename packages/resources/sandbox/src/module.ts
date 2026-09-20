import { sandboxExecutionHandler, sandboxManager, sandboxProviderRegistry } from "./server/services/index";
import type { SandboxExecutionHandler } from "./server/services/sandbox-execution-handler";
import type { SandboxManager } from "./server/services/sandbox-manager";
import type { SandboxProviderRegistry } from "./server/services/sandbox-provider-registry";

/**
 * Sandbox 模块的运行时表面。
 *
 * 只暴露需要"对象身份"的能力：`sandboxManager` 持有进程内的 provider 句柄、心跳定时器和实例锁，
 * 同一份 DB 记录只允许有一个生命周期 owner——再构造一个实例等于给同一批实例开两条回收路径。
 * 因此组合根返回的是包内既有单例，而不是新建一套。
 *
 * 路由工厂、`registerConfiguredSandboxProviders` 与 `initializeDefaultSandboxPool` 都是宿主显式
 * 调用的入口，不经过模块实例即可使用，故不在这里重复包装；等 registry 驱动的装配落地
 * （§1.5 的 `mountContribution`）需要统一拿到它们时再按需扩展。
 */
export interface SandboxModule {
  readonly id: "sandbox";
  /** Provider 注册表：装配期注册后端实现，运行期按 key 取用。 */
  readonly providers: SandboxProviderRegistry;
  /** 沙盒实例生命周期 owner：创建、恢复、销毁与心跳。 */
  readonly manager: SandboxManager;
  /** Agent 执行入口：把一次执行请求解析为可用的沙盒实例。 */
  readonly executions: SandboxExecutionHandler;
}

/** 创建 Sandbox 模块实例。 */
export function createSandboxModule(): SandboxModule {
  return {
    id: "sandbox",
    providers: sandboxProviderRegistry,
    manager: sandboxManager,
    executions: sandboxExecutionHandler,
  };
}
