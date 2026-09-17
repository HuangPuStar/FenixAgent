import * as z from "zod/v4";

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
