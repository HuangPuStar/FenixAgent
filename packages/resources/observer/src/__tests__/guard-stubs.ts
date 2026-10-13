import { Elysia } from "elysia";

/**
 * 路由工厂测试用的守卫替身。
 *
 * 三个 `/api/system/*` 路由的守卫由宿主注入（`systemApiGuardPlugin`，理由见
 * `../server/routes/dependencies`），资源包不得依赖 `apps/server`，因此包内用例只能注入替身。
 * 替身**只**提供工厂注册路由所必需的形状——`error` 装饰器与同名宏：少任一项 Elysia 会让路由构造
 * 失败；多复刻一份鉴权策略则会让「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * **真实守卫覆盖的实测结论（2026-09-20，本文件不重复声明未经实测的覆盖）**：守卫改为随工厂参数
 * 注入后，包内只能注入替身，替身放行不等于鉴权合同已验。实测宿主 `apps/server/src/__tests__/
 * api-system-routes.test.ts` 装配的是 identity 的 `createApiSystemRoutes`，用例只覆盖
 * `/api/system/users|organizations|api-keys`；全仓 `grep -rn "api/system/observer\|api/system/logs\|api/system/people-tree"
 * apps` 在 `__tests__` 下零命中，因此下列合同当前处于**无测试覆盖**状态：
 *   - `/api/system/observer/acp-link`、`/api/system/logs`（含 `/search`、`/download`）、
 *     `/api/system/people-tree` 在无 key、错误 key、以及未配置 `RCS_SYSTEM_API_KEYS` 三种情形下
 *     被拒绝（宿主 `systemApiAuthPlugin` 返回 401 `UNAUTHORIZED`）；
 *   - 同一批端点携带正确系统 key 时通过守卫到达处理器。
 * 这三条路由此前由包内用例**直接 `.use()` 宿主守卫**覆盖，随工厂化一并消失：改由宿主装配用例
 * （`apps/server/src/main.ts` 已按 `createApi*Routes({ systemApiGuardPlugin: systemApiAuthPlugin })`
 * 形态装配，宿主 patch 见任务 1.3 sharedPatches）承接，属 §1.5 宿主协议聚合。缺口消除后本注释应
 * 改为指向该用例。本包**不**复制鉴权策略：替身放行是刻意的，它只证明「路由构造与协议映射正确」。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/** 系统 API 守卫替身：构造出 `error` 装饰器与放行的 `systemApiKeyAuth` 宏。 */
export function createStubSystemApiGuardPlugin() {
  return new Elysia({ name: "test-system-api-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .macro({
      systemApiKeyAuth(enabled: boolean) {
        if (!enabled) return {};
        return { beforeHandle: () => undefined };
      },
    });
}
