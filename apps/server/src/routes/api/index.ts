import type { AnyElysia } from "elysia";
import Elysia from "elysia";

/**
 * `/api/*` 对外稳定 API 聚合实例。
 *
 * 本面的路由全部来自 registry 装配的路由贡献：包在自己的 manifest 里声明 `slot: "api"` 的 `app-route`
 * 贡献，宿主装配期按槽登记（`bootstrap/route-contributions.ts`），这里只按槽取出挂载。聚合实例本身不带
 * 前缀——各包的路由自带 `/api/...` 前缀（对外合同的一部分，不能由宿主拼接），因此这里只做「同一实例内
 * 的注册顺序」这一件事。
 *
 * 保留工厂（而不是模块级单例）的原因：贡献实例只有在 `bootstrapServerAssembly()` 的 mount 阶段才存在，
 * 而装配跑在 app 构造之前——顶层构造的单例拿不到它们（review §3.3 的时序）。
 *
 * 不挂守卫、不挂 OpenAPI：守卫由各包在构造处经 `ServerRouteHost` 注入（同一份实例），OpenAPI 由根 app
 * 统一装配，两者在这里都只会有第二份。
 */
export function createApiApp(slots: { readonly api: readonly AnyElysia[] }): AnyElysia {
  return (
    new Elysia({ name: "api" })
      // Elysia 的 `.use()` 接数组参数（不是展开），见 `node_modules/elysia/dist/index.d.ts` 的重载。
      .use([...slots.api])
  );
}
