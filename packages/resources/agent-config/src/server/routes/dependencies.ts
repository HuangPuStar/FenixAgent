/**
 * 本包路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，就会出现
 * 「入口 → 工厂 → 入口」的循环导入。这里只放类型（与从类型派生的函数签名），运行时不产生依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的
 * 子实例回填。守卫必须与宿主的认证解析（含测试 seam、active organization 解析）是同一份实例，否则同一
 * 进程里会出现两套互不可见的认证状态——`/web/*` 的 `store.actor` 与站点代理的请求级认证都会失效。
 */

import type { AnyElysia } from "elysia";
import type { UserAgentPreferencesPort } from "../ports/user-agent-preferences";

/** `/web/*` 控制台路由的宿主注入依赖。 */
export interface WebAgentConfigRouteDependencies {
  /** 会话认证守卫；`/web/*` 靠它取得 `store.actor` 与 `sessionAuth` 宏。 */
  readonly authGuardPlugin: AnyElysia;
}

/** `/api/agents` 对外稳定接口的宿主注入依赖（与 `/web` 共用会话守卫）。 */
export type ApiAgentConfigRouteDependencies = WebAgentConfigRouteDependencies;

/** `/web/config/agents` 的附加依赖：默认 Agent 偏好落在身份族的 `user_config` 表，由宿主适配。 */
export interface WebConfigAgentsRouteDependencies extends WebAgentConfigRouteDependencies {
  readonly userAgentPreferences: UserAgentPreferencesPort;
}

/**
 * 站点代理的请求级认证结果：只保留可见性判定需要的两个标识。
 *
 * 不用宿主 `RequestAuthResult` / `AuthContext` 的形状：包侧只判定「这个请求属于谁、在哪个组织」，把
 * 宿主认证对象整体搬进来会让包跟着宿主的上下文结构一起演进。
 */
export interface SiteRequestIdentity {
  readonly userId: string;
  readonly organizationId: string;
}

/**
 * 请求级认证函数，由宿主注入（宿主 `authenticateRequest` 的薄封装）。
 *
 * 站点代理不做 `sessionAuth` 宏校验——它要区分「未登录」与「已登录但无权限」并分别重定向，因此需要
 * 直接拿认证结果而不是让守卫短路请求。认证实现必须与守卫同一份，故同样走注入。
 */
export type AuthenticateSiteRequest = (request: Request) => Promise<SiteRequestIdentity | null>;

/** 站点代理（`/web/site/deploy/*` 与 `/app-*` 兜底）的宿主注入依赖。 */
export interface AgentSitesProxyRouteDependencies {
  readonly authenticateRequest: AuthenticateSiteRequest;
}
