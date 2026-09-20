import { Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（`/web/*` 用会话守卫），资源包不得依赖 `apps/server`，因此包内用例只能注入替身。
 * 替身**只**提供工厂注册路由所必需的形状——`error` 装饰器与同名宏：少任一项 Elysia 会让路由构造失败，
 * 多复刻一份鉴权策略则会让「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * **覆盖边界（2026-09-20 实测）**：拒答分支由本替身持有，因此本包用例证明的是「路由确实声明了
 * `sessionAuth: true`、未认证时在触达仓储前返回 401、已认证时把上下文转发给服务层」；而真实守卫的
 * 凭据解析与 401 映射由宿主用例覆盖（`apps/server/src/__tests__/round45-auth-plugin.test.ts`
 * 「session guard 拒绝未认证请求」，断言体与这里逐字一致）。真实守卫若要变更拒答响应体，本替身
 * 必须同步——两侧分歧会让本包的 401 断言变成对替身自身的断言。
 *
 * 插件名刻意与宿主守卫（`auth-guard`）不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/** 路由实际读取的认证上下文形状（宿主 `AuthContext` 的最小交集）。 */
export interface StubAuthContext {
  readonly userId: string;
  readonly organizationId: string;
}

/** 守卫替身句柄：可直接注入工厂，并在用例内切换认证状态。 */
export interface StubSessionAuthGuard {
  readonly plugin: Elysia;
  /** 切换当前请求的认证状态；`null` 表示未认证（宏返回 401，与宿主守卫同形）。 */
  setAuthContext(authContext: StubAuthContext | null): void;
}

/**
 * 创建会话守卫替身。
 *
 * 为什么把认证状态放在闭包里而不是每次新建插件：路由在用例文件顶层构造一次（Elysia 实例构造有成本，
 * 且插件名去重要求同一 app 内守卫与路由一一对应），而「未认证」用例需要切换状态——
 * 闭包让状态可切换，同时避免为每条用例重建整棵路由。
 */
export function createStubSessionAuthGuard(initial: StubAuthContext | null = null): StubSessionAuthGuard {
  let current = initial;

  const plugin = new Elysia({ name: "test-session-auth" })
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
            if (!current) return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
            store.authContext = current;
          },
        };
      },
    });

  return {
    plugin,
    setAuthContext(authContext) {
      current = authContext;
    },
  };
}
