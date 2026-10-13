import { Elysia } from "elysia";

/**
 * Trace 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（见 `../server/routes/dependencies`），资源包不得依赖 `apps/server`，因此包内用例只能注入
 * 替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器、`authContext` state、`user` 与同名
 * `sessionAuth` 宏：少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略则会让「两处策略各写一遍」的漂移
 * 风险进入测试设施（本包不复制鉴权策略）。
 *
 * `authContext` 为 null 时按宿主真实守卫的未认证分支拒绝（401 + `{ error: { type: "unauthorized" } }`）：
 * 被测路由都声明了 `sessionAuth: true`，该模式因此能逐端点验证「鉴权声明存在」，而不是把 401 变成宿主的
 * 专属用例。**凭据解析本身**（cookie / Environment Secret / API Key 的优先级与组织恢复）归宿主用例，包内
 * 不复制鉴权实现。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/** 替身写入 `store` 的最小形状；路由只消费 `user.id` 与 `authContext.organizationId`。 */
export interface StubAuthContext {
  organizationId: string;
  userId: string;
}

export function createStubSessionAuthGuardPlugin(authContext: StubAuthContext | null) {
  return new Elysia({ name: "test-trace-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ authContext: null as StubAuthContext | null, user: null as { id: string } | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({
            store,
            error,
          }: {
            store: { authContext: StubAuthContext | null; user: { id: string } | null };
            error: (code: number, body: unknown) => Response;
          }) => {
            if (!authContext) {
              return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
            }
            store.authContext = authContext;
            store.user = { id: authContext.userId };
          },
        };
      },
    });
}
