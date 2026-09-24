import type { ActorContext } from "@fenix/platform-sdk";
import { Elysia } from "elysia";

/**
 * 路由工厂测试用的两道守卫替身（浏览面会话守卫 / 管理面系统 API 守卫）。
 *
 * 两道门都由宿主注入（`/web/config/plugin-market/*` 用会话守卫，`/api/system/plugin-market/*` 用系统 API
 * 守卫），资源包不得依赖 `apps/server`（`bun run architecture:check` 的 `apps-boundary` 会失败），因此包内
 * 用例只能注入替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器、`actor` state 与同名宏：少任一
 * 项 Elysia 会让路由构造失败，多复刻一份鉴权策略（cookie → Environment Secret → API Key 的解析顺序、系统
 * key 的匹配、组织归属复核）则会让「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * 真实守卫覆盖的缺口：本包注入替身后，八条路由的**鉴权本身**不再有包内用例覆盖（替身放行是刻意的，它只证明
 * 「路由构造与协议映射正确」，不证明鉴权生效）；宿主侧装配用例应覆盖「无凭据 → 401」与「已认证但缺组织上下文
 * → 401」。本包已有后者的一半判断（路由层 401），前者属宿主守卫的职责范围。
 *
 * 插件名刻意与宿主守卫不同（`"test-plugin-market-session-auth"` / `"test-plugin-market-system-api-auth"`）：
 * Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效，出现「用例以为注入了替身、实际用的是宿主守卫」
 * 这种不可见的状态串台。
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

/**
 * 系统 API 守卫替身（管理面）。
 *
 * 与真实守卫（`apps/server/src/plugins/system-api-auth.ts`）的形状差异只有一处：**不校验凭据**，只按开关放行
 * ——「无凭据 → 401」属宿主守卫的职责，用例在这里重复一遍只会掩盖真实的守卫回归。放行时**不写任何 state**：
 * 真实守卫也只写 `store.systemAuth`，而管理面的 handler 刻意不读它（判据在守卫，Facade 不接收 actor）。
 *
 * 开关是构造参数而不是用例可改的状态：`deny: true` 用于断言「守卫拒绝时路由体一次都不执行」，写死成常量可以
 * 让每条用例的意图只由它自己的入参表达。
 */
export function createStubSystemApiGuardPlugin(deny = false) {
  return new Elysia({ name: "test-plugin-market-system-api-auth" })
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
        return {
          beforeHandle: ({ error }: { error: (code: number, response: unknown) => unknown }) => {
            if (deny) return error(401, { error: { code: "UNAUTHORIZED", message: "Invalid system API key" } });
          },
        };
      },
    });
}
