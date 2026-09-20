import type { ObserverService } from "./server/services/observer";
import { observerService } from "./server/services/observer";

/**
 * Observer 模块的运行时表面。
 *
 * 只暴露需要「对象身份」的能力：`observerService` 持有进程内 kind → Provider 注册表，Provider
 * 可按 kind 独立注册 / 摘除（文档 §3.1 的可回滚前提）。装配方若各构造一份，同一进程里就会出现
 * 互不可见的注册表——路由查到的 Provider 集合与装配方以为注册的集合不再是同一份。
 * 因此组合根返回包内既有单例，而不是新建一套。
 *
 * 三个系统级路由工厂是宿主显式调用的入口（守卫随参数注入，理由见 `./server/routes/dependencies`），
 * 不经过模块实例即可使用，故不在这里重复包装；等 registry 驱动的装配落地（§1.5 的
 * `mountContribution`）需要统一拿到它们时再按需扩展——现在包装只会多出一层无消费方的转发。
 */
export interface ObserverModule {
  readonly id: "observer";
  /** 观察面注册表与聚合入口：kind → Provider、`tree()` / `list()`。 */
  readonly service: ObserverService;
}

/** 创建 Observer 模块实例（返回进程级单例，见接口注释）。 */
export function createObserverModule(): ObserverModule {
  return { id: "observer", service: observerService };
}
