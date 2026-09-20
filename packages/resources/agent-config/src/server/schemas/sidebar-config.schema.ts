import * as z from "zod/v4";

/**
 * 侧边栏公开配置的协议 DTO。
 *
 * 从宿主 `apps/server/src/schemas/sidebar-config.schema.ts` 迁入（CE 阶段 2 任务 1.3）：该 schema 只
 * 描述本包路由的响应，随路由一起归本包，宿主不再保有一份（宿主侧删除记在 sharedPatches）。
 */

/** 侧边栏公开配置数据 */
export const SidebarConfigSchema = z
  .object({
    hiddenTabs: z.array(z.string()).describe("需要在前端侧边栏中隐藏的 tab id 列表。"),
  })
  .describe("侧边栏公开配置数据。");

/** GET /web/sidebar-config 成功响应 */
export const SidebarConfigResponseSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
    data: SidebarConfigSchema.describe("当前侧边栏配置。"),
  })
  .describe("获取侧边栏配置的响应。");

export type SidebarConfig = z.infer<typeof SidebarConfigSchema>;
export type SidebarConfigResponse = z.infer<typeof SidebarConfigResponseSchema>;
