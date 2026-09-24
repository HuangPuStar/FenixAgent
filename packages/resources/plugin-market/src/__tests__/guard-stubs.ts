import type { ActorContext } from "@fenix/platform-sdk";
import { Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（`/web/config/plugin-market/*` 用宿主的会话守卫），资源包不得依赖 `apps/server`
 * （`bun run architecture:check` 的 `apps-boundary` 会失败），因此包内用例只能注入替身。替身**只**提供工厂
 * 注册路由所必需的形状——`error` 装饰器、`actor` state 与同名 `sessionAuth` 宏：少任一项 Elysia 会让路由构造
 * 失败，多复刻一份鉴权策略（cookie → Environment Secret → API Key 的解析顺序、组织归属复核）则会让「两处策略
 * 各写一遍」的漂移风险进入测试设施。
 *
 * 真实守卫覆盖的缺口：本包注入替身后，六条路由的**鉴权本身**不再有包内用例覆盖（替身放行是刻意的，它只证明
 * 「路由构造与协议映射正确」，不证明鉴权生效）；宿主侧装配用例应覆盖「无凭据 → 401」与「已认证但缺组织上下文
 * → 401」。本包已有后者的一半判断（路由层 401），前者属宿主守卫的职责范围。
 *
 * 插件名刻意与宿主守卫不同（`"test-plugin-market-session-auth"`）：Elysia 按 plugin `name` 去重，同名会让先
 * 构造的一方静默生效，出现「用例以为注入了替身、实际用的是宿主守卫」这种不可见的状态串台。
 */
export function createStubSessionAuthGuardPlugin(actor: ActorContext | null) {
  return new Elysia({ name: "test-plugin-market-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ actor: null as ActorContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({ store }: { store: { actor: ActorContext | null } }) => {
            store.actor = actor;
          },
        };
      },
    });
}
