import Elysia from "elysia";
import { SidebarConfigResponseSchema } from "../../schemas";
import { getSidebarConfig } from "../../services/sidebar-config";

const app = new Elysia({ name: "web-sidebar-config", prefix: "/sidebar-config" })
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

export default app;
