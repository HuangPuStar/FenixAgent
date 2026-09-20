import { registerStubResetter } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import type { AuthContext, RequestAuthResult } from "../types/auth";

/**
 * 路由工厂测试用的认证替身（1.4 W2：三条路由改为工厂后，认证由宿主注入，包内用例只能注入替身）。
 *
 * 替身**只**提供工厂注册路由所必需的形状——`error` 装饰器、`user` / `authContext` 两个 state 槽位与
 * `sessionAuth` 宏，少任一项 Elysia 会让路由构造失败或请求期读到 `undefined`；多复刻一份凭据解析
 * （cookie / Environment Secret / API Key 三条路径、active organization 解析、限流）则会把
 * 「两处策略各写一遍」的漂移风险带进测试设施，而那些规则属宿主 `apps/server/src/plugins/auth.ts`
 * 与宿主装配用例的验收范围。
 *
 * 与迁移前的差别：宿主 `setTestAuth` 注入的 `AuthContext` 带 `role` 与全量 `memberships`，本包路由
 * 从不读这两项（授权判断属宿主），因此替身只维护组织与用户两个标识——「测试注入了组织但路由读到别的
 * 组织」这类不一致在接缝层面就不存在。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/** 替身会话入参：本包路由只消费归属组织与用户。 */
export interface TestAuthInput {
  readonly organizationId: string;
  readonly userId: string;
}

let session: { readonly signedIn: boolean; readonly authContext: AuthContext | null } = {
  signedIn: false,
  authContext: null,
};

/** 设置已认证会话。 */
export function setTestAuth(input: TestAuthInput): void {
  session = { signedIn: true, authContext: { organizationId: input.organizationId, userId: input.userId } };
}

/** 清空替身会话：未认证请求应被守卫拒绝，用例结束必须复位避免泄漏到下一条用例。 */
export function resetTestAuth(): void {
  session = { signedIn: false, authContext: null };
}

/** 会话守卫替身：实现 `sessionAuth` 宏（注入当前替身会话 / 未认证时 401）。 */
export function createStubAgentRuntimeAuthGuardPlugin() {
  return (
    new Elysia({ name: "test-agent-runtime-auth-guard" })
      // 宿主守卫用同一形状覆盖 Elysia 的 `error`：路由以 `error(status, body)` 返回错误响应。
      .decorate({
        error(code: number, response: unknown) {
          return new Response(JSON.stringify(response), {
            status: code,
            headers: { "Content-Type": "application/json" },
          });
        },
      })
      .state({ user: null as { id: string } | null, authContext: null as AuthContext | null })
      .macro({
        sessionAuth(enabled: boolean) {
          if (!enabled) return {};
          return {
            beforeHandle: ({
              store,
              error,
            }: {
              store: { user: { id: string } | null; authContext: AuthContext | null };
              error: (code: number, response: unknown) => unknown;
            }) => {
              if (!session.signedIn || !session.authContext) {
                return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
              }
              store.user = { id: session.authContext.userId };
              store.authContext = session.authContext;
            },
          };
        },
      })
  );
}

/** 请求级认证替身：`/acp/*` 的 WS 升级路径不走 `sessionAuth` 宏，直接取认证结果。 */
export function createStubAuthenticateRequest() {
  return async (_request: Request): Promise<RequestAuthResult | null> => {
    if (!session.signedIn || !session.authContext) return null;
    return { user: { id: session.authContext.userId }, authContext: session.authContext };
  };
}

// 复位登记：替身会话是模块级状态，不复位会跨用例泄漏（症状是「单独跑通过、全量跑失败」）。
registerStubResetter(resetTestAuth);
