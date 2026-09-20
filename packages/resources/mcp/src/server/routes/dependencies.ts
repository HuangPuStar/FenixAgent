/**
 * MCP 路由的宿主注入依赖。
 *
 * 单独成文件而不是放在 `src/server.ts`：路由工厂需要声明自己的依赖类型，若类型定义在包入口，
 * 就会出现「入口 → 工厂 → 入口」的循环导入。这里只放类型，运行时不产生任何依赖。
 *
 * 为什么是注入而不是本包自建守卫：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已
 * 构造的子实例回填。守卫必须与宿主的认证解析（session cookie / Environment Secret / API Key、
 * 测试 seam、active organization 解析）是同一份实例，否则同一进程会出现两套互不可见的认证状态，
 * 且 Elysia 会按 plugin `name` 去重让先构造的一方静默生效。
 *
 * `/web/config/mcp` 与 `/api/mcp` 共用同一份会话守卫（两者的 `sessionAuth` 宏与 `store.actor`
 * 都由它写入），因此这里只有一个依赖接口；`/mcp/knowledge` 用 Bearer environment secret 自鉴权，
 * 不取守卫也不读 `store`，故不在本文件的依赖面内。
 */

import type { AnyElysia } from "elysia";

/** 会话认证守卫；`/web/config/mcp` 与 `/api/mcp` 靠它取得 `store.actor`。 */
export interface McpRouteDependencies {
  readonly authGuardPlugin: AnyElysia;
}
