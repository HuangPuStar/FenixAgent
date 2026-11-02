import type { ActorContext } from "@fenix/platform-sdk";
import { registerStubResetter } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（`/web/*` 都用会话守卫），资源包不得依赖 `apps/server`，因此包内用例只能注入替身。
 * 替身只提供工厂注册路由所必需的形状——`error` 装饰器、`user` / `actor` 两个 state 槽位与 `sessionAuth`
 * 宏：少任一项 Elysia 会让路由构造失败或请求期读到 `undefined`，多复刻一份鉴权策略则会让「两处策略各写
 * 一遍」的漂移风险进入测试设施。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

export interface TestAuthInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly role?: "owner" | "admin" | "member";
}

let session: { readonly signedIn: boolean; readonly actor: ActorContext | null } = {
  signedIn: false,
  actor: null,
};

/** 设置已认证会话；默认 `owner` 角色，需要区分角色（如管理员绑定 Agent）的用例显式传 `role`。 */
export function setTestAuth(input: TestAuthInput): void {
  const role = input.role ?? "owner";
  session = {
    signedIn: true,
    actor: {
      kind: "user",
      userId: input.userId,
      activeOrganizationId: input.organizationId,
      memberships: [{ organizationId: input.organizationId, role }],
    },
  };
}

/** 设置「已认证但没有任何 active organization」的会话，用于覆盖路由的 401 分支。 */
export function setTestActorWithoutOrganization(): void {
  session = { signedIn: true, actor: null };
}

/** 清空替身会话；用例结束必须复位，避免泄漏到下一条用例。 */
export function resetTestAuth(): void {
  session = { signedIn: false, actor: null };
}

/** 会话认证守卫替身：实现 `sessionAuth` 宏（注入当前替身会话 / 未认证时 401）。 */
export function createStubSessionAuthGuardPlugin() {
  return new Elysia({ name: "test-channel-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ user: null as { id: string } | null, actor: null as ActorContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({
            store,
            error,
          }: {
            store: { user: { id: string } | null; actor: ActorContext | null };
            error: (code: number, response: unknown) => unknown;
          }) => {
            if (!session.signedIn) {
              return error(401, { success: false, error: { code: "UNAUTHORIZED", message: "未认证" } });
            }
            store.user = session.actor ? { id: session.actor.userId } : null;
            store.actor = session.actor;
          },
        };
      },
    });
}

// 复位登记：替身会话是模块级状态，不复位会跨用例泄漏（症状是「单独跑通过、全量跑失败」）。
registerStubResetter(resetTestAuth);

/** 系统 API 守卫替身接受的那个 key；用例据此构造带 / 不带凭据两种请求。 */
export const TEST_SYSTEM_API_KEY = "test-system-key";

/**
 * 系统 API 守卫替身：`/api/system/channels` 的守卫由宿主注入（见 `../server/routes/dependencies`）。
 *
 * 与放行的会话守卫不同，这一份**会拒绝**：它按 `Authorization: Bearer <TEST_SYSTEM_API_KEY>` 判定，缺凭据
 * 时返回与宿主同形状的 401。理由不是要复刻鉴权策略，而是需要一条能证伪的断言——若路由漏声明
 * `systemApiKeyAuth: true`，不带凭据的请求就会直接进处理器并返回 200，用例立刻失败。真实的 key 校验规则
 * 仍归宿主 `systemApiAuthPlugin`，本替身不参与。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重。
 */
export function createStubSystemApiGuardPlugin() {
  return new Elysia({ name: "test-channel-system-api-auth" })
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
          beforeHandle: ({
            headers,
            error,
          }: {
            headers: Record<string, string | undefined>;
            error: (code: number, response: unknown) => unknown;
          }) => {
            if (headers.authorization !== `Bearer ${TEST_SYSTEM_API_KEY}`) {
              return error(401, { error: { code: "UNAUTHORIZED", message: "系统 API key 无效" } });
            }
            return;
          },
        };
      },
    });
}
