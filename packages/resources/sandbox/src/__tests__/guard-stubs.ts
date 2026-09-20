import { Elysia } from "elysia";

/**
 * 路由工厂测试用的守卫替身。
 *
 * 守卫由宿主注入（`/web/*` 用会话守卫，`/api/system/*` 用系统 key 守卫），资源包不得依赖
 * `apps/server`，因此包内用例只能注入替身。替身**只**提供工厂注册路由所必需的形状——
 * `error` 装饰器与同名宏：少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略则会让
 * 「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * 已发布合同是「路由 + 真实守卫 + `RCS_SYSTEM_API_KEYS`」，由宿主用例覆盖
 * （`apps/server/src/__tests__/api-system-routes.test.ts` 的同形写法），不在本包重复断言。
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
