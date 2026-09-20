import type { ActorContext } from "@fenix/platform-sdk";
import { registerStubResetter } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身（迁移前宿主 `setTestAuth` / `setTestOrgContext` 的包内等价物）。
 *
 * 守卫由宿主注入（`/web/*` 与 `/api/*` 都用会话守卫），资源包不得依赖 `apps/server`，因此包内用例只能
 * 注入替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器、`user` / `actor` 两个 state 槽位与
 * `sessionAuth` 宏：少任一项 Elysia 会让路由构造失败或请求期读到 `undefined`，多复刻一份鉴权策略则会让
 * 「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * 与迁移前的差别（也是本文件存在的理由）：宿主旧接缝的 `setTestAuth` 注入 `AuthContext`、
 * `setTestOrgContext` 另外注入组织上下文，包内路由读的是后者；现在路由只读平台 `ActorContext`
 * （`store.actor`），因此替身只维护**一个**可变的会话对象——组织、用户与当前组织角色都在里面，
 * 「测试注入了组织但路由读到别的组织」这类不一致状态在接缝层面就不存在。
 *
 * 未认证时替身按宿主 `sessionAuth` 的契约在 `beforeHandle` 拒绝（401 + `/web` 错误信封），不进入
 * handler：这是「未认证请求必须被挡在 handler 之前」的装配契约。**已认证但没有 active organization**
 * 的情形（API Key 未绑定组织）由 `setTestActorWithoutOrganization` 表达，此时放行到 handler，由路由
 * 自己的空主体分支返回 401——生产路径就是这么分流的。
 *
 * 真实守卫的覆盖归属：会话解析（cookie / Environment Secret / API Key 三条路径、active organization
 * 解析、限流）属宿主 `apps/server/src/plugins/auth.ts` 与宿主路由装配用例的验收范围；本替身只证明
 * 「路由构造、认证拒绝与协议映射正确」，不证明凭据解析规则。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/** 替身会话入参：角色只影响 `memberships`，语义与宿主 `toActorContext` 的投影一致。 */
export interface TestAuthInput {
  readonly organizationId: string;
  readonly userId: string;
  readonly role?: "owner" | "admin" | "member";
}

let session: { readonly signedIn: boolean; readonly actor: ActorContext | null } = {
  signedIn: false,
  actor: null,
};

/**
 * 设置已认证会话；用法与迁移前的 `setTestAuth` + `setTestOrgContext` 合并后一致。
 *
 * 默认角色 `owner`：绝大多数用例只关心「已认证的当前组织成员能通过」，需要区分角色（能否写站点）的
 * 用例显式传 `role`，避免默认值悄悄放宽被测的权限分支。
 */
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

/**
 * 设置「已认证但没有任何 active organization」的会话。
 *
 * 对应生产路径：API Key 未绑定组织（`store.actor` 为 null）。用例用它覆盖路由的 401 分支——这条分支
 * 迁移前读的是 `store.authContext!`，无组织时以 TypeError 变成 500。
 */
export function setTestActorWithoutOrganization(): void {
  // 不带入用户标识：无组织时路由不会读到 `store.actor`，写入任何 userId 都只是伪造未使用的状态。
  session = { signedIn: true, actor: null };
}

/** 清空替身会话：未认证请求应被路由拒绝，用例结束必须复位避免泄漏到下一条用例。 */
export function resetTestAuth(): void {
  session = { signedIn: false, actor: null };
}

/** 会话认证守卫替身：实现 `sessionAuth` 宏（注入当前替身会话 / 未认证时 401）。 */
export function createStubSessionAuthGuardPlugin() {
  return new Elysia({ name: "test-agent-config-session-auth" })
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
