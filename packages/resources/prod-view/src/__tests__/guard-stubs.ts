import { Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（`/web/config/prod-views*` 与 `/web/prod-views/:id/load` 都是控制台会话端点），
 * 资源包不得依赖 `apps/server`，因此包内用例只能注入替身。替身**只**提供工厂注册路由所必需的形状：
 * `error` 装饰器与同名宏——少任一项 Elysia 会让路由构造失败，而多复刻一份鉴权策略则会把「两处策略
 * 各写一遍」的漂移风险带进测试设施。
 *
 * **真实守卫覆盖的实测结论（2026-09-20）**：`grep -rln "prod-view\|prodView" apps/server/src/__tests__/
 * apps/web/src/__tests__/` 无任何命中，即宿主当前**没有** prod-view 端点用例。因此下列合同处于无测试
 * 覆盖状态，本替身不证明它们是安全的：
 *   - 无会话 cookie 时两个端点组被拒绝（宿主守卫返回 401 而不是进入处理器）；
 *   - 会话的组织上下文由守卫解析后写入 `store.authContext`，服务读取的必须是这一份（替身总是直接
 *     写入给定组织，跳过了「从 cookie/API Key 恢复组织并校验成员关系」的过程）。
 * 归属：宿主用例（任务 1.3 §1.5 的宿主协议聚合），缺口已登记在任务 1.3 的 sharedPatches；宿主用例补齐后
 * 本注释应改为指向该用例。本包不复制鉴权策略——替身放行是刻意的，它只证明「路由构造与协议映射正确」，
 * 不证明鉴权生效。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

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
