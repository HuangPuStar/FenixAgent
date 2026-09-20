import type { ActorContext } from "@fenix/platform-sdk";
import { Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（`/api/skills` 与 `/web/config/skills` 都用宿主的会话守卫），资源包不得依赖
 * `apps/server`（`bun run architecture:check` 的 `apps-boundary` 会失败），因此包内用例只能注入替身。
 * 替身**只**提供工厂注册路由所必需的形状——`error` 装饰器、`actor` state 与同名 `sessionAuth` 宏：
 * 少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略（cookie → Environment Secret → API Key 的
 * 解析顺序、组织归属复核）则会让「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * 真实守卫覆盖的缺口：本包注入替身后，两条路由的**鉴权本身**不再有包内用例覆盖（替身放行是刻意的，
 * 它只证明「路由构造与协议映射正确」，不证明鉴权生效）；宿主侧装配用例（任务 1.3 §1.5）应覆盖
 * 「无凭据 → 401」「已认证但缺组织上下文 → 401」与「跨组织资源不可见」。缺口已登记在任务 1.3 的
 * sharedPatches；宿主用例补齐后本注释应指向该用例。
 *
 * 插件名刻意与宿主守卫不同（`"test-skill-session-auth"`）：Elysia 按 plugin `name` 去重，同名会让先
 * 构造的一方静默生效，出现「用例以为注入了替身、实际用的是宿主守卫」这种不可见的状态串台。
 */

/**
 * 构造会话守卫替身。
 *
 * `actor` 为 `null` 时模拟"已认证但没有组织上下文"（例如未绑定组织的 API Key）：守卫放行、不写
 * `store.actor`，由路由层返回 401——这正是宿主守卫在该情形下的实际行为，用例因此覆盖了资源包的
 * 那一半判断（守卫不负责报错，只是不注入主体）。
 */
export function createStubSessionAuthGuardPlugin(actor: ActorContext | null) {
  return new Elysia({ name: "test-skill-session-auth" })
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
