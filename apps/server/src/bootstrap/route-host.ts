import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { authenticateRequest, authGuardPlugin } from "../plugins/auth";
import { logError } from "../plugins/logger";
import { systemApiAuthPlugin } from "../plugins/system-api-auth";
import {
  environmentLookup,
  resolveSecretReference,
  userAgentPreferences,
  userModelPreferences,
  verifyEnvironmentOwnership,
} from "../services/resource-module-ports";

/**
 * 宿主协议 adapter 面（`ServerRouteHost`）的唯一实现（review §3.3）。
 *
 * 这些字段是资源包路由工厂需要、而只有宿主能提供的端口：会话守卫与显式认证入口（认证状态的真相来源
 * 在 `plugins/auth`；Elysia 的 macro / state 是实例作用域的，父实例无法向已构造的子实例回填）、系统
 * API 守卫、Environment 归属查询与校验、身份族 `user_config` 上的两个偏好端口、读宿主 env 的密钥引用
 * 解析。字段类型在 platform-sdk 侧全是 `unknown`，收窄由各包在自己的 `src/server/assembly.ts` 做一次。
 *
 * Environment 归属校验的真相在 agent-runtime，Host 负责注入；`logError` 随协议路由迁入，
 * 要读宿主中间件写在 request 上的 requestId 与起始时间，包内拿不到。
 *
 * 本文件不持有状态、不做校验：端口是否被真正使用由各包声明，装配期只用它构造路由实例。
 */
export const serverRouteHost: ServerRouteHost = {
  authGuardPlugin,
  systemApiGuardPlugin: systemApiAuthPlugin,
  authenticateRequest,
  environmentLookup,
  userAgentPreferences,
  userModelPreferences,
  resolveSecretReference,
  verifyEnvironmentOwnership,
  logError,
};
