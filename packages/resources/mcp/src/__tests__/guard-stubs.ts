import type { ActorContext } from "@fenix/platform-sdk";
import { type AnyElysia, Elysia } from "elysia";

/**
 * 路由工厂测试用的会话守卫替身。
 *
 * 守卫改为随工厂参数注入后，包内用例不能再 `import { setTestAuth } from "@server/plugins/auth"`：
 * 资源包不得依赖宿主实现，测试设施同样不能（那会把「宿主怎么解析会话」变成资源包测试的隐含前置）。
 * 替身只提供工厂注册路由所必需的两项——`error` 装饰器与 `sessionAuth` 宏，并把用例给定的主体写进
 * `store.actor`：路由读的就是这一个字段（`grep -rn "store\." src/server/routes` 只有 `actor`）。
 *
 * **替身不复制鉴权策略**：它不做凭据解析，也不区分「未认证」与「已认证但无 active organization」——
 * 两种情况在路由看到的世界里都是 `actor === null`，路由据此返回 401（`/api` 侧同形）。真实守卫的
 * 拒绝路径（无 session / 无效 Environment Secret / 无效 API Key）属于宿主认证编排，由宿主用例覆盖；
 * 本包不在此复刻一份策略，否则「两处策略各写一遍」的漂移风险会进入测试设施。
 *
 * 插件名刻意与宿主守卫（`auth-guard`）不同：Elysia 按 plugin `name` 去重，同名会让先构造的一方静默生效。
 */

/**
 * 守卫替身与主体控制面：`setActor(null)` 模拟路由收到无主体请求。
 *
 * `plugin` 声明为 `AnyElysia` 而非裸 `Elysia`：`decorate` / `state` / `macro` 会把实例泛型收窄成具体
 * 形状，裸 `Elysia` 是更窄的默认泛型，具体实例恰好不可赋值给它；`AnyElysia` 与路由依赖接口
 * （`src/server/routes/dependencies.ts`）用的是同一个类型，注入处无需再断言。
 */
export interface StubMcpAuthGuard {
  readonly plugin: AnyElysia;
  setActor(actor: ActorContext | null): void;
}

/** 构造会话守卫替身；默认无主体，用例须显式 `setActor`（漏设时表现为 401，不会静默放行）。 */
export function createStubMcpAuthGuardPlugin(): StubMcpAuthGuard {
  const holder: { actor: ActorContext | null } = { actor: null };

  const plugin = new Elysia({ name: "test-mcp-session-auth" })
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
            store.actor = holder.actor;
          },
        };
      },
    });

  return {
    plugin,
    setActor(actor) {
      holder.actor = actor;
    },
  };
}
