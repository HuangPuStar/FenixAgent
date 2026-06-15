import * as z from "zod/v4";

/** 通道平台类型 */
export const ChannelProviderTypeSchema = z.enum(["wechat", "feishu"]).describe("通道平台类型。");

/** 通道平台状态 */
export const ChannelProviderStatusSchema = z.enum(["disabled", "enabled"]).describe("通道平台状态。");

/** 通道平台描述 */
export const ChannelProviderDescriptorSchema = z.object({
  type: ChannelProviderTypeSchema,
  label: z.string().describe("平台显示名称。"),
  status: ChannelProviderStatusSchema,
});

/** Hermes 服务状态 */
export const HermesStatusSchema = z.object({
  connected: z.boolean().describe("Hermes 是否已连接。"),
  url: z.string().describe("Hermes 服务地址。"),
  platforms: z.array(z.string()).describe("当前已连接的平台列表。"),
  reconnecting: z.boolean().describe("是否正在重连。"),
  lastConnectedAt: z.number().nullable().describe("最近一次连接时间戳，单位为秒；未连接时为 null。"),
});

/** 通道绑定信息 */
export const ChannelBindingSchema = z.object({
  id: z.string().describe("绑定 ID。"),
  platform: z.string().describe("绑定的平台类型。"),
  chatId: z.string().nullable().describe("聊天会话 ID；为 null 时表示平台下的通配绑定。"),
  agentId: z.string().describe("关联的环境 ID。"),
  enabled: z.boolean().describe("绑定是否启用。"),
  agentName: z.string().nullable().optional().describe("关联环境名称。"),
});

/** 创建通道绑定请求体 */
export const CreateChannelBindingRequestSchema = z.object({
  platform: z.string().min(1, "platform 为必填字段").describe("平台类型。"),
  chatId: z.string().nullable().optional().describe("可选聊天会话 ID。"),
  agentId: z.string().min(1, "agentId 为必填字段").describe("要绑定的环境 ID。"),
  enabled: z.boolean().optional().default(true).describe("是否启用绑定。"),
});

/** 更新通道绑定请求体 */
export const UpdateChannelBindingRequestSchema = z.object({
  platform: z.string().optional().describe("更新后的平台类型。"),
  chatId: z.string().nullable().optional().describe("更新后的聊天会话 ID。"),
  agentId: z.string().optional().describe("更新后的环境 ID。"),
  enabled: z.boolean().optional().describe("更新后的启用状态。"),
});

/** GET /web/channels/providers — 通道供应商列表 */
export const ChannelProviderListResponseSchema = ChannelProviderDescriptorSchema.array().describe("通道平台列表。");

/** GET /web/channels/bindings — 通道绑定列表 */
export const ChannelBindingListResponseSchema = ChannelBindingSchema.array().describe("通道绑定列表。");

/** POST /web/channels/bindings — 创建绑定响应 */
export const CreateChannelBindingResponseSchema = ChannelBindingSchema.describe("创建后的通道绑定信息。");

/** DELETE /web/channels/bindings/:id — 删除绑定响应 */
export const DeleteChannelBindingResponseSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
  })
  .describe("删除通道绑定后的响应。");

/** PATCH /web/channels/bindings/:id — 更新绑定响应 */
export const UpdateChannelBindingResponseSchema = ChannelBindingSchema.describe("更新后的通道绑定信息。");

export type ChannelProviderDescriptor = z.infer<typeof ChannelProviderDescriptorSchema>;
export type HermesStatus = z.infer<typeof HermesStatusSchema>;
export type ChannelBinding = z.infer<typeof ChannelBindingSchema>;
export type CreateChannelBindingRequest = z.infer<typeof CreateChannelBindingRequestSchema>;
export type UpdateChannelBindingRequest = z.infer<typeof UpdateChannelBindingRequestSchema>;
export type ChannelProviderListResponse = z.infer<typeof ChannelProviderListResponseSchema>;
export type ChannelBindingListResponse = z.infer<typeof ChannelBindingListResponseSchema>;
export type CreateChannelBindingResponse = z.infer<typeof CreateChannelBindingResponseSchema>;
export type DeleteChannelBindingResponse = z.infer<typeof DeleteChannelBindingResponseSchema>;
export type UpdateChannelBindingResponse = z.infer<typeof UpdateChannelBindingResponseSchema>;
