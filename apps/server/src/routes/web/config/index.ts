import Elysia, { type AnyElysia } from "elysia";

/**
 * `/web/config/*` 聚合实例。
 *
 * 本面的路由全部来自 registry 装配的路由贡献（1.5e 起逐包迁入）：包在自己的 manifest 里声明
 * `slot: "web-config"` 的 `app-route` 贡献，宿主装配期按槽取出（`bootstrap/route-contributions.ts`）后
 * 在这里挂载。宿主不再维护手写序列——贡献之间的相对顺序由装配收集顺序决定，兜底类贡献在自己声明处写
 * `order` 自证优先级（review §3.3），不需要「谁必须最后挂」的清单。
 *
 * 保留工厂（而不是模块级单例）的原因：贡献实例只有在 `bootstrapServerAssembly()` 的 mount 阶段才存在，
 * 而装配跑在 app 构造之前——顶层构造的单例拿不到它们（review §3.3 的时序）。
 *
 * 守卫注入不再是本文件的职责：资源包的路由贡献经 `ServerRouteHost`（`bootstrap/route-host.ts`，唯一实现）
 * 在装配期拿到与宿主认证解析同一份实例的守卫；Elysia 的 macro / state 是实例作用域的，父实例无法向已
 * 构造的子实例回填，因此注入发生在构造处而不是挂载处。
 */
export function createWebConfigApp(contributedRoutes: readonly AnyElysia[]): AnyElysia {
  return (
    new Elysia({ name: "web-config" })
      // Elysia 的 `.use()` 接数组参数（不是展开），见 `node_modules/elysia/dist/index.d.ts` 的重载。
      .use([...contributedRoutes])
  );
}
