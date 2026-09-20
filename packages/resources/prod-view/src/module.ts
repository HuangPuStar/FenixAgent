import type { IProdViewRepository } from "./server/repositories/prod-view";
import { prodViewRepo } from "./server/repositories/prod-view";

/**
 * ProdView 模块的运行时表面。
 *
 * 只暴露需要「对象身份」的能力：`prodViewRepo` 是 `prod_view` 表的**唯一数据访问点**——
 * 同一条记录的组织谓词、软删除语义与字段映射都只写在这里，再构造一个仓储实例就等于给同一张表
 * 开第二条访问路径，读写谓词迟早分叉。因此组合根返回包内既有单例，而不是新建一套。
 *
 * 路由工厂（`createWebProdViewsRoutes` / `createWebConfigProdViewsRoutes`）、领域服务函数与 schema
 * 都是无状态入口，宿主显式调用即可使用，不需要经模块实例转发，故不在这里重复包装；等 registry
 * 驱动的装配（§1.5 的 `mountContribution`）需要统一取用时再按需扩展。
 */
export interface ProdViewModule {
  readonly id: "prod-view";
  /** `prod_view` 表的唯一数据访问点。 */
  readonly repository: IProdViewRepository;
}

/**
 * 创建 ProdView 模块实例。
 *
 * 进程级单例语义（同 sandbox 样本）：返回的是包内既有单例的视图，重复调用不会产生第二份状态。
 */
export function createProdViewModule(): ProdViewModule {
  return {
    id: "prod-view",
    repository: prodViewRepo,
  };
}
