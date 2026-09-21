import type { BootstrapModulesOptions } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { type AnyElysia, Elysia } from "elysia";
import { serverRouteHost } from "./route-host";

/**
 * 装配期登记的路由贡献（1.5e）。
 *
 * 模块在 manifest 的 `contributions` 里声明「怎么造这条路由」（惰性构造函数 + 聚合槽名），但造出来的
 * 实例不能立刻挂载：`bootstrapServerAssembly()` 跑在宿主 app 构造**之前**（review §3.3），此时还没有
 * 可挂的聚合实例。所以装配阶段只做「构造 + 登记到槽」，main.ts 构造聚合（`routes/web/index.ts` 的
 * `createWebApp`）时再按槽取出、`.use()` 进去。
 *
 * 槽名是包与宿主之间的约定面：包声明「挂到 `/web`、`/web/config`、`/api` 还是顶层 `app`」，宿主负责把
 * 槽名映射到具体聚合实例。未知槽名当场报错——静默丢弃一个路由贡献等于让整组端点消失，比装配失败更难
 * 排查。
 */

/** `/web` 聚合槽（`routes/web/index.ts` 的 `createWebApp`）。 */
export const WEB_SLOT = "web";
/** `/web/config` 聚合槽（`routes/web/config/index.ts` 的 `createWebConfigApp`）。 */
export const WEB_CONFIG_SLOT = "web-config";
/** `/api/*` 对外稳定 API 聚合槽（`routes/api/index.ts` 的 `createApiApp`）。 */
export const API_SLOT = "api";
/**
 * 顶层应用槽（`main.ts` 的根 app）。
 *
 * 走这一槽的是**不共享前缀**的协议入口：`/skills/*` 下载、`/acp`、`/mcp/knowledge`、`/hooks/*`、
 * `/workflow-ui/*`、`/web/site/deploy/*` 与 `/app-*` 兜底。它们的注册顺序有语义（`/*` 兜底必须最后挂），
 * 因此贡献在自己的声明处写 `order` 自证（`ModuleContribution.order` 的既定用途），宿主不维护「谁必须
 * 最后挂」的清单。
 */
export const APP_SLOT = "app";

/** 路由贡献的构造函数形状：装配期把宿主协议面交给包，由包返回构造好的 Elysia 实例。 */
type RouteContributionFactory = (host: ServerRouteHost) => unknown;

/** 已登记的槽位；进程级单例，装配只发生一次。 */
const slottedRoutes = new Map<string, AnyElysia[]>();

/**
 * 宿主读得到的槽位。
 *
 * 四个槽都有真实消费者：`web` / `web-config` 由 `createWebApp` 取，`api` 由 `createApiApp` 取，`app` 由
 * `main.ts` 的根 app 取。声明一个不在这里的槽名会当场报错——静默丢弃一个路由贡献等于让整组端点消失。
 */
const READABLE_SLOTS: readonly string[] = [WEB_SLOT, WEB_CONFIG_SLOT, API_SLOT, APP_SLOT];

/**
 * `mountContribution` 的宿主实现：只处理路由贡献。
 *
 * 非 `app-route` 的贡献（协议、生命周期）在 1.5 内尚无消费方，直接跳过——它们由后续任务接线时在此
 * 扩展，而不是现在猜一个形状。
 */
export const mountServerRouteContribution: NonNullable<BootstrapModulesOptions["mountContribution"]> = async ({
  contribution,
  manifest,
}) => {
  if (contribution.kind !== "app-route") return;

  const slot = contribution.slot ?? "app";
  if (!READABLE_SLOTS.includes(slot)) {
    throw new Error(
      `模块 ${manifest.id} 的贡献 ${contribution.id} 指向未知聚合槽 "${slot}"（已接线：${READABLE_SLOTS.join(" / ")}）`,
    );
  }

  const createRoute = contribution.value;
  if (typeof createRoute !== "function") {
    throw new Error(`模块 ${manifest.id} 的贡献 ${contribution.id} 声明为 app-route，但 value 不是构造函数`);
  }

  const route = await (createRoute as RouteContributionFactory)(serverRouteHost);
  if (!(route instanceof Elysia)) {
    throw new Error(`模块 ${manifest.id} 的贡献 ${contribution.id} 没有返回 Elysia 实例`);
  }

  const registered = slottedRoutes.get(slot);
  if (registered) registered.push(route);
  else slottedRoutes.set(slot, [route]);
};

/** 读取某个聚合槽登记的路由；未登记的槽返回空数组（该 profile 未启用任何贡献到这一面的模块）。 */
export function takeRouteContributions(slot: string): readonly AnyElysia[] {
  return slottedRoutes.get(slot) ?? [];
}

/** 清空登记的路由贡献；只服务测试，避免跨用例共享装配结果。 */
export function resetRouteContributions(): void {
  slottedRoutes.clear();
}
