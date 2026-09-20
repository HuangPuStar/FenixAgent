import { Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫由宿主注入（`/web/*` 与 `/api/workflows/*` 都用会话守卫），资源包不得依赖 `apps/server`，
 * 因此包内用例只能注入替身。替身**只**提供工厂注册路由所必需的形状——`error` 装饰器与同名宏：
 * 少任一项 Elysia 会让路由构造失败，多复刻一份鉴权策略则会让「两处策略各写一遍」的漂移风险进入测试设施。
 *
 * **它证明什么、不证明什么**：`stubSessionAuth` 只证明「路由声明了 `sessionAuth: true`，守卫拒绝时处理器
 * 不执行」——如果哪条路由漏了宏，替身的 beforeHandle 就不会跑，用例断言的 401 会变成 200/500 而失败。
 * 它**不**证明宿主的真实鉴权策略（session cookie / Environment Secret / API Key 三种凭据的解析与
 * active organization 提取）。这部分由宿主用例覆盖：迁移前 workflow 的 `/web/*` 路由由宿主真实守卫
 * 保护，包内用例经 `setTestAuth()` 借用了同一份守卫；改为注入替身后，真实守卫的覆盖面回落。
 *
 * **当前缺口（2026-09-20 实测）**：宿主 `apps/server/src/__tests__/` 下没有任何用例装配 workflow 的
 * `/web/*`、`/api/workflows/*`、`/workflow-ui` 路由（`grep -rn "workflow-runs\|workflow-defs\|workflow-engine"
 * apps/server/src --include="*.ts"` 只命中 `db/schema.ts`），因此下列合同当前处于**无测试覆盖**状态：
 *   - `/web/workflow-*` 端点在无会话时被宿主守卫拒绝（401），有会话时把 active organization 写入
 *     `store.authContext`；
 *   - `/api/workflows/:workflowId/execute` 的会话/API Key 凭据链与组织上下文恢复；
 *   - `/workflow-ui/*` 代理端点的会话校验。
 * 归属：宿主协议聚合（§1.5 的宿主装配用例），缺口已登记在任务 1.3 的 sharedPatches。宿主用例补齐后
 * 本注释应改为指向该用例；本包**不**复制鉴权策略。
 *
 * 插件名刻意与宿主守卫不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效，
 * 测试里表现为「替身没生效但用例仍然通过」。
 */

/** 守卫放行时写入 `store.authContext` 的字段（与 `WorkflowActorContext` 一致，避免循环 import 处重复声明）。 */
export interface StubWorkflowActor {
  readonly organizationId: string;
  readonly userId: string;
}

/**
 * 会话守卫替身。
 *
 * 默认未认证（`actor = null`）：用例显式调用 `setActor()` 给出当前请求的 actor，需要验证「未认证被拒」
 * 时再切回 null。可变 actor 而不是两个不同插件，是因为路由在模块加载期就构造完成，用例只能在构造之后
 * 改变身份——这与宿主 `setTestAuth()` / `resetTestAuth()` 的用法一一对应。
 */
export function createStubSessionAuthGuard(actor: StubWorkflowActor | null = null) {
  let current = actor;
  const plugin = new Elysia({ name: "test-workflow-session-auth" })
    .decorate({
      error(code: number, response: unknown) {
        return new Response(JSON.stringify(response), {
          status: code,
          headers: { "Content-Type": "application/json" },
        });
      },
    })
    .state({ authContext: null as StubWorkflowActor | null })
    .macro({
      sessionAuth(enabled: boolean) {
        if (!enabled) return {};
        return {
          // biome-ignore lint/suspicious/noExplicitAny: Elysia macro 上下文类型无法完整表达（宿主守卫同一写法）
          beforeHandle: ({ store, error }: any) => {
            if (!current) {
              // 与宿主守卫的 401 信封保持一致（`apps/server/src/plugins/auth.ts` 的 sessionAuth 分支），
              // 用例断言的响应形状因此与生产一致。
              return error(401, { error: { type: "unauthorized", message: "Not authenticated" } });
            }
            store.authContext = current;
          },
        };
      },
    });

  return Object.assign(plugin, {
    /** 切换当前请求的 actor；`null` 表示未认证。 */
    setActor(next: StubWorkflowActor | null) {
      current = next;
    },
  });
}
