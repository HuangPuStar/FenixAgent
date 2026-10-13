import { Elysia } from "elysia";
import type { SessionAuthContext } from "../server/routes/dependencies";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（`/web/knowledgeBases*` 与 `/api/knowledge-bases` 都用会话守卫），资源包不得依赖
 * `apps/server`，因此包内用例只能注入替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器
 * 与同名宏：少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略则会让「两处策略各写一遍」的漂移
 * 风险进入测试设施。
 *
 * `authContext` 传 `null` 时进入**拒绝**模式（返回宿主守卫同形的 401），用于覆盖「端点确实声明了
 * `sessionAuth: true`」：这类用例证明的是路由把守卫接上了，而不是本包在复述鉴权策略。真实守卫下的
 * 认证行为由宿主用例负责（本包无法在不依赖宿主实现的前提下覆盖，缺口见 README 的已知项）。
 *
 * 插件名刻意与宿主守卫（`auth-guard`）不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默
 * 生效，测试里就会出现「注入的替身没起作用、却因为真实守卫恰好也放行而通过」的假绿。
 */
export function createStubSessionAuthGuardPlugin(authContext: SessionAuthContext | null) {
  return new Elysia({ name: "test-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ authContext: null as SessionAuthContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({
            store,
            error,
          }: {
            store: { authContext: SessionAuthContext | null };
            error: (code: number, body: unknown) => Response;
          }) => {
            if (!authContext) return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
            store.authContext = authContext;
          },
        };
      },
    });
}
