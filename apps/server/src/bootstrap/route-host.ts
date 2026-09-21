import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { authenticateRequest, authGuardPlugin } from "../plugins/auth";
import { systemApiAuthPlugin } from "../plugins/system-api-auth";
import {
  environmentLookup,
  resolveSecretReference,
  userAgentPreferences,
  userModelPreferences,
} from "../services/resource-module-ports";

/**
 * 宿主协议 adapter 面（`ServerRouteHost`）的唯一实现（review §3.3）。
 *
 * 这些字段是资源包路由工厂需要、而只有宿主能提供的端口：会话守卫与显式认证入口（认证状态的真相来源
 * 在 `plugins/auth`；Elysia 的 macro / state 是实例作用域的，父实例无法向已构造的子实例回填）、系统
 * API 守卫、Environment 归属查询、身份族 `user_config` 上的两个偏好端口、以及读宿主 env 的密钥引用
 * 解析。字段类型在 platform-sdk 侧全是 `unknown`，收窄由各包在自己的 `src/server/assembly.ts` 做一次。
 *
 * 七项一次填满而不是「谁先迁入谁先加」：它们的实现都已经存在且是同一份进程级实例，逐片追加字段会让
 * 每迁一个包就改一次宿主装配面；这里一次到位的代价只是几行对象字面量，收益是 1.5e 后续各包不再动宿主。
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
};
