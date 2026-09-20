import { Elysia } from "elysia";

/**
 * 通道路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（见 `../server/routes/dependencies`），资源包不得依赖 `apps/server`，因此包内用例
 * 只能注入替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器、`authContext` state 与
 * 同名 `sessionAuth` 宏：少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略则会让「两处策略各写
 * 一遍」的漂移风险进入测试设施。
 *
 * **真实守卫的覆盖边界（与 sandbox 同口径的实测结论）**：替身通过 `sessionAuth` 宏把给定上下文写入
 * `store.authContext`，不解析 cookie / Environment Secret / API Key。因此本包用例证明的是「路由声明了
 * `sessionAuth`、未认证时按宿主守卫的响应形状被拦下、认证后按组织隔离」；**凭据解析本身**（凭据优先级、
 * 组织上下文恢复、限流）归 §1.5 的宿主用例，包内不复制鉴权实现。
 *
 * 插件名刻意与宿主守卫（`auth-guard`）不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方
 * 静默生效，用例会以为自己注入的替身生效了。
 */

/** 替身写入 `store.authContext` 的最小形状；路由只消费这两个字段。 */
export interface StubAuthContext {
  organizationId: string;
  userId: string;
}

/**
 * 构造会话守卫替身。
 *
 * `authContext` 为 `null` 时按宿主真实守卫的未认证分支拒绝：401 + `{ error: { type: "unauthorized" } }`
 * （形状取自 `apps/server/src/plugins/auth.ts` 的 `sessionAuth` 宏）。被测路由声明了 `sessionAuth: true`
 * 才会经过这条分支，因此该模式可以逐端点验证「鉴权声明存在」，而不是把 401 变成宿主的专属用例。
 */
export function createStubSessionAuthGuardPlugin(authContext: StubAuthContext | null) {
  return new Elysia({ name: "test-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ authContext: null as StubAuthContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({
            store,
            error,
          }: {
            store: { authContext: StubAuthContext | null };
            error: (code: number, body: unknown) => Response;
          }) => {
            if (!authContext) {
              return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
            }
            store.authContext = authContext;
          },
        };
      },
    });
}
