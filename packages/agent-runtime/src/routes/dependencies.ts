/**
 * 本包路由工厂的宿主注入依赖（1.4 W2 起三条路由改为工厂，认证与错误日志由宿主装配）。
 *
 * 单独成文件而不放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，就会出现
 * 「入口 → 工厂 → 入口」的循环导入。这里只有类型，运行时不产生依赖。
 *
 * 为什么是注入而不是包内自建守卫（与 `@fenix/agent-config` 的 `routes/dependencies.ts` 同因）：
 * Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；守卫必须与宿主的认证
 * 解析（含测试 seam 与 active organization 解析）是同一份**实例**，否则同一进程里会出现两套互不可见的
 * 认证状态——宿主 `/web/*` 路由的 `store.authContext` 与本包路由的会各自为政。
 */

import type { AnyElysia } from "elysia";
import type { RequestAuthResult } from "../types/auth";

/** 会话守卫：注入后路由才能声明 `sessionAuth` 宏并读到 `store.user` / `store.authContext`。 */
export interface AgentRuntimeAuthDependencies {
  readonly authGuardPlugin: AnyElysia;
}

/**
 * `/acp/*` 的附加依赖：WS 升级路径自己认证（不走 `sessionAuth` 宏）。
 *
 * 三条 WS 端点要在 `open` 里区分「未认证 / 无组织上下文 / 通过」并分别以 4003 关闭连接，因此需要
 * 请求级认证函数本身。实现必须与 {@link AgentRuntimeAuthDependencies.authGuardPlugin} 用同一份
 * 认证解析——宿主传的是它自己的 `authenticateRequest`。
 */
export interface AcpRouteDependencies extends AgentRuntimeAuthDependencies {
  readonly authenticateRequest: (request: Request) => Promise<RequestAuthResult | null>;
}

/**
 * 宿主请求错误日志钩子（`apps/server/src/plugins/logger.ts` 的 `logError`）的契约。
 *
 * 为什么由宿主注入而不是搬进包内：它是宿主请求日志管道的 onError 钩子——要读 `request` 上的
 * `__requestId`、`__startTime` 与最终状态码，这三样都由宿主的 `deriveRequestId` / `logResponse`
 * 中间件写入，包内没有它们的来源。包内另立一份只会让同一次失败在两条日志管道里各记一次，且丢掉
 * requestId 关联。因此本包只声明「需要一个记录错误的回调」，诊断内容（如 sandboxId / providerKey）
 * 由宿主按既有脱敏口径写入服务端日志。
 */
export type RequestErrorLogger = (context: {
  readonly request: Request;
  readonly error: unknown;
  readonly set: { status?: number | string; headers: Record<string, string | number> };
}) => void;

/** `/api/instances` 的附加依赖：失败请求的服务端诊断日志。 */
export interface ApiInstanceRouteDependencies extends AgentRuntimeAuthDependencies {
  readonly logError: RequestErrorLogger;
}
