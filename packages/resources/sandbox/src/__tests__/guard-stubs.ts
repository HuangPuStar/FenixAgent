import { Elysia } from "elysia";

/**
 * 路由工厂测试用的守卫替身。
 *
 * 守卫由宿主注入（`/web/*` 用会话守卫，`/api/system/*` 用系统 key 守卫），资源包不得依赖
 * `apps/server`，因此包内用例只能注入替身。替身**只**提供工厂注册路由所必需的形状——
 * `error` 装饰器与同名宏：少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略则会让
 * 「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * **真实守卫覆盖的实测结论（2026-09-20 修正本文件先前的错误声明）**：先前此处写「已发布合同
 * （路由 + 真实守卫 + `RCS_SYSTEM_API_KEYS`）由宿主用例覆盖」，实测不成立。宿主
 * `apps/server/src/__tests__/api-system-routes.test.ts` 装配的是 identity 的 `createApiSystemRoutes`，
 * 用例只覆盖 `/api/system/users|organizations|api-keys`，**没有任何** `/api/system/sandbox*` 用例。
 * 因此下列合同当前处于**无测试覆盖**状态：
 *   - 以 `systemApiKeyAuth: true` 声明的沙盒端点（`/api/system/sandbox-pools*`、
 *     `/api/system/sandbox-cluster/*`、`/api/system/sandbox-server/*`）在无 key、错误 key、以及
 *     未配置 `RCS_SYSTEM_API_KEYS` 三种情形下被拒绝（宿主守卫返回 401 `UNAUTHORIZED`）；
 *   - 同一批端点携带正确系统 key 时通过守卫到达处理器。
 * 原因：守卫改为随路由工厂参数注入后，包内只能注入替身（注入真实守卫即等于依赖宿主实现），
 * 而宿主侧的沙盒路由装配用例尚未补——`apps/server/src/main.ts` 已按
 * `createApiSandbox*Routes({ systemApiGuardPlugin: systemApiAuthPlugin })` 装配这三组路由。
 * 归属：宿主用例（任务 1.3 §1.5 的宿主协议聚合），缺口已登记在任务 1.3 的 sharedPatches；
 * 宿主用例补齐后本注释应改为指向该用例。本包**不**复制鉴权策略：替身放行是刻意的，它只证明
 * 「路由构造与协议映射正确」，不证明鉴权生效。
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

/** 会话认证守卫替身：放行 `sessionAuth` 宏并把给定组织写入 `store.authContext`。 */
export function createStubSessionAuthGuardPlugin(authContext: { organizationId: string; userId: string }) {
  return new Elysia({ name: "test-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ authContext: null as typeof authContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({ store }: { store: { authContext: typeof authContext | null } }) => {
            store.authContext = authContext;
          },
        };
      },
    });
}
