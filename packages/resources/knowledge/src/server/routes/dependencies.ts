/**
 * Knowledge 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，就会出现
 * 「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的
 * 子实例回填。守卫必须与宿主的认证解析（session cookie / Environment Secret / API Key、测试 seam、
 * active organization 解析）是同一份实例，否则同一进程会出现两套互不可见的认证状态，且 Elysia 会按
 * plugin `name` 去重让先构造的一方静默生效。
 *
 * `/web/knowledgeBases*`（20 条控制台端点）与 `/api/knowledge-bases`（对外稳定接口）共用同一份会话
 * 守卫：两者的 `sessionAuth` 宏与 `store.authContext` 都由它写入，因此只有一个依赖接口。本包没有系统
 * API key 面，不声明 `systemApiGuardPlugin`。
 */

import type { AnyElysia } from "elysia";

/**
 * 守卫写入 `store.authContext` 的会话上下文。
 *
 * 只声明本包实际消费的两个标识，而不是复用宿主守卫的完整 `AuthContext` 类型：宿主守卫是注入进来的
 * 黑盒，包内只需要「谁在哪个组织」这一窄契约，多声明的字段会变成对宿主内部形状的隐性依赖。宿主守卫
 * 写入的对象结构上满足本类型。
 */
export interface SessionAuthContext {
  readonly organizationId: string;
  readonly userId: string;
}

/** Knowledge 路由的宿主注入依赖。 */
export interface KnowledgeRouteDependencies {
  /** 会话认证守卫；路由靠它取得 `store.authContext`。 */
  readonly authGuardPlugin: AnyElysia;
}
