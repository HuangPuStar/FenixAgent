import { registerStubResetter } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import type { MachineRequestAuth } from "../server/types/auth";

/**
 * 路由工厂测试用的会话守卫替身与认证注入（迁移前宿主 `setTestAuth` / `resetTestAuth` 的包内等价物）。
 *
 * 守卫由宿主注入（`/web/*`、`/api/*` 用会话守卫），资源包不得依赖 `apps/server`，因此包内用例只能注入
 * 替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器、`user` / `authContext` 两个 state 槽位与
 * `sessionAuth` 宏：少任一项 Elysia 会让路由构造失败或请求期读到 `undefined`，多复刻一份鉴权策略则会让
 * 「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * `error` 装饰器与宿主 `errorResponse` 逐字同形（`JSON.stringify` + `Content-Type`）而不是让 Elysia 用默认
 * 实现：路由的 4xx 响应体（如 fs 的 `{ error: { type, message } }`）是协议契约，替身若换一种序列化，测试
 * 断言的就不再是生产形状。
 *
 * 未注入会话时替身按宿主的 `sessionAuth` 契约拒绝：`error(401, { error: { type: "unauthorized", ... } })`
 * ——「未认证请求必须被挡在 handler 之前」是路由装配的契约（handler 直接读 `store.authContext!`），
 * 替身放行会让用例观察到 `undefined` 组织上下文这类生产不可能出现的状态。
 *
 * 真实守卫的覆盖归属：会话解析（cookie / Environment Secret / API Key 三条路径、active organization 解析、
 * 限流）属宿主 `apps/server/src/plugins/auth.ts` 的验收范围，由宿主路由装配用例覆盖；本替身只证明
 * 「路由构造、认证拒绝与协议映射正确」，不证明凭据解析规则。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/** 守卫下发的用户视图；本包路由只读 `id`。 */
export interface MachineTestUser {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

/** 当前替身会话：`sessionAuth` 宏在请求期读取它，因此用例内改动能立即生效（不必重建路由实例）。 */
let session: { user: MachineTestUser | null; authContext: MachineRequestAuth | null } = {
  user: null,
  authContext: null,
};

/** 设置替身会话（用法与迁移前宿主的 `setTestAuth` 一致）。 */
export function setTestAuth(next: { user: MachineTestUser; authContext: MachineRequestAuth }): void {
  session = next;
}

/** 清空替身会话：未认证请求应被路由拒绝，用例结束必须复位避免泄漏到下一条用例。 */
export function resetTestAuth(): void {
  session = { user: null, authContext: null };
}

/** 会话认证守卫替身：实现 `sessionAuth` 宏（注入当前替身会话 / 未认证时 401）。 */
export function createStubSessionAuthGuardPlugin() {
  return new Elysia({ name: "test-machine-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({
      user: null as MachineTestUser | null,
      authContext: null as MachineRequestAuth | null,
    })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({
            store,
            error,
          }: {
            store: { user: MachineTestUser | null; authContext: MachineRequestAuth | null };
            error: (code: number, body: unknown) => Response;
          }) => {
            if (!session.user || !session.authContext) {
              return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
            }
            store.user = session.user;
            store.authContext = session.authContext;
          },
        };
      },
    });
}

// 复位登记：替身会话是模块级状态，用例只调 `resetAllStubs()` 一处即可连同其他替身一起清空。
registerStubResetter(resetTestAuth);
