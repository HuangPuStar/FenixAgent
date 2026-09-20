import type { ActorContext } from "@fenix/platform-sdk";
import { Elysia } from "elysia";

/**
 * 路由工厂测试用的守卫替身。
 *
 * 守卫由宿主注入（`/web/*` 与 `/api/models` 用会话守卫，`/api/system/*` 用系统 key 守卫），资源包不得
 * 依赖 `apps/server`，因此包内用例只能注入替身。替身**只**提供工厂注册路由所必需的形状——`error`
 * 装饰器、`actor` state 与同名宏：少任一项 Elysia 会让路由构造失败或让 handler 读到 undefined，多复刻
 * 一份鉴权策略则会让「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * 取 actor 的方式是**取值函数**而不是固定值：`/web/config/models` 的缓存按主体分键，用例必须在同一个
 * 应用实例上用不同身份连续发请求，才能证明 owner 预热的缓存不会漏给同组织的 member。
 *
 * **真实守卫不进入包内测试**：会话守卫（`apps/server/src/plugins/auth.ts`）读 DB、解析 active
 * organization 并写 ALS 上下文，是宿主实现；包内注入它等于依赖宿主。它的端到端覆盖归宿主的装配用例
 * （`/api/models` 等路由的宿主侧合同测试），本包只证明「路由构造与协议映射正确」，不证明鉴权生效。
 *
 * 插件名刻意与宿主守卫（`auth-guard` / `system-api-auth`）不同：Elysia 按 plugin `name` 去重，同名会让
 * 先构造的一方静默生效。
 */

/** 生成宿主守卫的 `error(code, body)` 装饰器形状。 */
function errorDecorator() {
  return {
    error(code: number, response: unknown) {
      return new Response(JSON.stringify(response), {
        status: code,
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}

/** 会话守卫替身：放行 `sessionAuth` 宏并把 `getActor()` 的返回值写入 `store.actor`。 */
export function createStubSessionAuthGuardPlugin(getActor: () => ActorContext | null) {
  return new Elysia({ name: "test-session-auth" })
    .decorate(errorDecorator())
    .state({ actor: null as ActorContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({ store }: { store: { actor: ActorContext | null } }) => {
            store.actor = getActor();
          },
        };
      },
    });
}

/**
 * 系统 API 守卫替身：构造出 `error` 装饰器与 `systemApiKeyAuth` 宏，授权结果由取值函数决定。
 *
 * 默认放行（`() => true`），拒绝分支用于覆盖「无系统 key 时整组路由关闭」这条路径——系统面的每个端点
 * 都必须在进入 handler 前拒绝，而不是让下游服务替它兜底。与 {@link createStubSessionAuthGuardPlugin}
 * 同因，取值函数而不是固定布尔：同一条用例可以在不停重建应用实例的前提下切换授权状态。
 */
export function createStubSystemApiGuardPlugin(isAuthorized: () => boolean = () => true) {
  return new Elysia({ name: "test-system-api-auth" }).decorate(errorDecorator()).macro({
    systemApiKeyAuth(enabled: boolean) {
      if (!enabled) return {};
      return {
        beforeHandle: ({ error }: { error: (code: number, body: unknown) => Response }) =>
          isAuthorized() ? undefined : error(401, { error: { code: "UNAUTHORIZED", message: "缺少系统 API Key" } }),
      };
    },
  });
}
