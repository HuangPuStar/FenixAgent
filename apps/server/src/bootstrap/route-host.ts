import { rotateCallerApiKey } from "@fenix/identity/server";
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
 * 解析、以及身份侧实现的调用方 API Key 轮换。字段类型在 platform-sdk 侧全是 `unknown`，收窄由各包在
 * 自己的 `src/server/assembly.ts` 做一次。
 *
 * 十个端口分三批到位：前七项在试点片（1.5e-1）一次填满，避免每迁一个包就改一次宿主装配面；后两项留到
 * 2b-2，与消费它们的路由（`/web/meta-agent/ensure`、peri 任务详情）同批——API Key 轮换与 Environment
 * 归属校验的真相都不在资源包内（`apikey` 表属 identity，`Environment` 表属 agent-runtime），Host 是唯一
 * 同时持有两侧的装配层；`logError` 在 1.5f-1 随协议路由迁入（`/api/agents/:agentId/instances/connect`
 * 是唯一消费方），它要读宿主中间件写在 request 上的 requestId 与起始时间，包内拿不到。
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
  rotateCallerApiKey,
  logError,
};
