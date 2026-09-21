import type { AnyElysia } from "elysia";
import Elysia from "elysia";
import webBranding from "./branding";
import { createWebConfigApp } from "./config";

/** 按聚合槽传入的路由贡献；槽位定义与装配期收集见 `apps/server/src/bootstrap/route-contributions.ts`。 */
export interface WebRouteSlots {
  readonly web: readonly AnyElysia[];
  readonly webConfig: readonly AnyElysia[];
}

/**
 * `/web` 聚合实例。
 *
 * 两条手写挂载是宿主自有的路由，不属于任何模块：`branding`（控制台品牌素材）与 `/web/config` 聚合实例
 * （它把 `web-config` 槽的路由收进 `/web/config` 前缀，见同目录 `config/index.ts`）。除此之外本文件不
 * 再认识任何包——资源包与基础模块的路由都由 manifest 的 `app-route` 贡献声明，装配期按槽登记
 * （`bootstrap/route-contributions.ts`），这里只按槽取出挂载（1.5e 的终点）。
 *
 * 贡献之间的相对顺序由装配收集顺序（拓扑序 + manifest 内声明序）决定，兜底类贡献在自己声明处写
 * `order` 自证优先级，宿主不维护「谁必须最后挂」的清单（review §3.3）。
 *
 * 改为工厂（不再是模块级单例）的原因：贡献实例只有在 `bootstrapServerAssembly()` 的 mount 阶段才存在，
 * 而装配跑在 app 构造之前——顶层构造的单例拿不到它们（review §3.3 的时序）。
 */
export function createWebApp(slots: WebRouteSlots): AnyElysia {
  return (
    new Elysia({ name: "web", prefix: "/web" })
      .use(webBranding)
      .use(createWebConfigApp(slots.webConfig))
      // Elysia 的 `.use()` 接数组参数（不是展开），见 `node_modules/elysia/dist/index.d.ts` 的重载。
      .use([...slots.web])
  );
}
