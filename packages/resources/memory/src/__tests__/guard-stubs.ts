import { Elysia } from "elysia";

/**
 * `/web/hindsight/**` 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（本包不得依赖 `@server/plugins/auth`，否则离开宿主即无法构造路由），因此包内用例
 * 只能注入替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器与放行的 `sessionAuth`
 * 宏：少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略则会让「两处策略各写一遍」的漂移风险
 * 进入测试设施（本包不复制鉴权策略，放行是刻意的）。
 *
 * **真实守卫覆盖的缺口（与 `@fenix/resource-sandbox` 的同类注释同口径）**：迁移前的
 * `round60-hindsight-routes.test.ts` 有两条「未认证 graph / status 必须 401」用例，它们经
 * `setTestAuth` + 宿主守卫验证拒绝路径；守卫改为宿主注入后，包内无法再表达该场景（注入真实守卫
 * 即等于依赖宿主实现）。实测宿主 `apps/server/src/__tests__/` 当前**没有**任何 hindsight 路由用例，
 * 因此下列合同暂时无测试覆盖：
 *   - `/web/hindsight/**` 在无 session / 无效 API Key 时被宿主守卫拒绝（401，且不访问上游）；
 *   - 同一批端点携带有效凭据时通过守卫到达处理器。
 * 归属：宿主用例（任务 1.3 §1.5 的宿主协议聚合），缺口已登记在任务 1.3 的 sharedPatches；
 * 宿主用例补齐后本注释应改为指向该用例。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/** 替身写入 `store.authContext` 的最小形状；与 `HindsightActor` 结构一致，宿主真实上下文是其超集。 */
export interface StubHindsightAuthContext {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * 会话认证守卫替身：放行 `sessionAuth` 宏，并把 `getAuthContext()` 的当前值写入 `store.authContext`。
 *
 * 用取值函数而不是固定对象：`/web/hindsight/**` 的隔离维度是「活跃组织 → bank」，同一进程内切换
 * 组织后必须读到新值（round60 的跨组织用例依赖这一点）。
 */
export function createStubSessionAuthGuardPlugin(getAuthContext: () => StubHindsightAuthContext) {
  return new Elysia({ name: "test-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ authContext: null as StubHindsightAuthContext | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          beforeHandle: ({ store }: { store: { authContext: StubHindsightAuthContext | null } }) => {
            store.authContext = getAuthContext();
          },
        };
      },
    });
}
