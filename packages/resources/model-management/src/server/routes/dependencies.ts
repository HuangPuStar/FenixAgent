/**
 * 本包路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，就会出现
 * 「入口 → 工厂 → 入口」的循环导入。这里只放类型（与一个从类型派生的解析器类型），运行时不产生依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的
 * 子实例回填。守卫必须与宿主的认证解析（含测试 seam、active organization 解析）是同一份实例，否则同一
 * 进程里会出现两套互不可见的认证状态——`/web/*` 的 `store.actor` 与 `/api/system/*` 的 key 校验都会
 * 失效。
 */

import type { AnyElysia } from "elysia";
import type { SecretReferenceResolver } from "../config-envelope";
import type { UserModelPreferencesPort } from "../ports/user-model-preferences";

/** `/web/*` 控制台路由的宿主注入依赖。 */
export interface WebModelManagementRouteDependencies {
  /** 会话认证守卫；`/web/*` 靠它取得 `store.actor` 与 `sessionAuth` 宏。 */
  readonly authGuardPlugin: AnyElysia;
}

/** `/api/system/*` 系统管理路由的宿主注入依赖。 */
export interface SystemApiModelManagementRouteDependencies {
  /** 系统 API key 守卫（`RCS_SYSTEM_API_KEYS`），与普通请求认证互不相关。 */
  readonly systemApiGuardPlugin: AnyElysia;
}

/** `/api/models` 对外稳定接口的宿主注入依赖（与 `/web` 共用会话守卫）。 */
export type ApiModelManagementRouteDependencies = WebModelManagementRouteDependencies;

/**
 * `/web/config/providers` 的附加依赖。
 *
 * 密钥引用解析（`{env:NAME}` → 环境变量值）与偏好读写都要落在宿主一侧：前者读 `process.env`、后者读
 * 身份族的 `user_config` 表，包内 `src/**` 两件事都不能做（1.3 硬条件 4 与表归属）。
 */
export interface WebConfigProvidersRouteDependencies extends WebModelManagementRouteDependencies {
  /** 解析 `{env:NAME}` 形式的密钥引用；明文与空值按 `SecretReferenceResolver` 的约定处理。 */
  readonly resolveSecretReference: SecretReferenceResolver;
}

/** `/web/config/models` 的附加依赖。 */
export interface WebConfigModelsRouteDependencies extends WebModelManagementRouteDependencies {
  /** 用户模型偏好的读写端口（宿主 `user_config` 表的薄适配）。 */
  readonly userModelPreferences: UserModelPreferencesPort;
}
