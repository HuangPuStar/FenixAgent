import Elysia from "elysia";
import { SidebarConfigResponseSchema } from "../../schemas/sidebar-config.schema";
import { getSidebarConfig } from "../../services/sidebar-config";

/**
 * `/web/sidebar-config` — 控制台侧边栏的公开展示配置。
 *
 * 从 `src/routes/web/sidebar-config.ts` 迁入（CE 阶段 2 任务 1.3，§2.3 目录约定）：服务端路由统一在
 * `src/server/routes/**` 下，`src/routes/**` 不再存在。
 *
 * 工厂无依赖：该端点在登录页也要可用（前端据它决定隐藏哪些 tab），刻意不声明 `sessionAuth`，因此
 * 不需要宿主注入会话守卫。返回值在请求时才读模块配置，模块加载期宿主可能尚未完成基础设施初始化。
 */
export function createWebSidebarConfigRoutes() {
  return new Elysia({ name: "web-sidebar-config", prefix: "/sidebar-config" })
    .model({
      "sidebar-config-response": SidebarConfigResponseSchema,
    })
    .get(
      "/",
      () => ({
        success: true as const,
        data: getSidebarConfig(),
      }),
      {
        response: "sidebar-config-response",
        detail: {
          tags: ["Sidebar"],
          summary: "获取侧边栏公开配置",
          description: "返回当前系统前端侧边栏的公开展示配置，例如需要隐藏的 tab 列表。",
        },
      },
    );
}
