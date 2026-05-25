import * as z from "zod/v4";
import { OkResponseSchema } from "./common.schema";

export const ChannelProviderTypeSchema = z.enum(["wechat", "feishu"]);
export const ChannelProviderStatusSchema = z.enum(["disabled", "enabled"]);

export const ChannelProviderDescriptorSchema = z.object({
  type: ChannelProviderTypeSchema,
  label: z.string(),
  status: ChannelProviderStatusSchema,
});

export const HermesStatusSchema = z.object({
  connected: z.boolean(),
  url: z.string(),
  platforms: z.array(z.string()),
  reconnecting: z.boolean(),
  lastConnectedAt: z.number().nullable(),
});

export const ChannelBindingSchema = z.object({
  id: z.string(),
  platform: z.string(),
  chatId: z.string().nullable(),
  agentId: z.string(),
  enabled: z.boolean(),
  agentName: z.string().nullable().optional(),
});

export const CreateChannelBindingRequestSchema = z.object({
  platform: z.string().min(1, "platform 为必填字段"),
  chatId: z.string().nullable().optional(),
  agentId: z.string().min(1, "agentId 为必填字段"),
  enabled: z.boolean().optional().default(true),
});

/** GET /web/channels/providers — 通道供应商列表 */
export const ChannelProviderListResponseSchema = ChannelProviderDescriptorSchema.array();

/** GET /web/channels/bindings — 通道绑定列表 */
export const ChannelBindingListResponseSchema = ChannelBindingSchema.array();

/** POST /web/channels/bindings — 创建绑定响应 */
export const CreateChannelBindingResponseSchema = ChannelBindingSchema;

/** DELETE /web/channels/bindings/:id — 删除绑定响应 */
export const DeleteChannelBindingResponseSchema = OkResponseSchema;

/** PATCH /web/channels/bindings/:id — 更新绑定响应 */
export const UpdateChannelBindingResponseSchema = ChannelBindingSchema;

export type ChannelProviderDescriptor = z.infer<typeof ChannelProviderDescriptorSchema>;
export type HermesStatus = z.infer<typeof HermesStatusSchema>;
export type ChannelBinding = z.infer<typeof ChannelBindingSchema>;
export type CreateChannelBindingRequest = z.infer<typeof CreateChannelBindingRequestSchema>;
export type ChannelProviderListResponse = z.infer<typeof ChannelProviderListResponseSchema>;
export type ChannelBindingListResponse = z.infer<typeof ChannelBindingListResponseSchema>;
export type CreateChannelBindingResponse = z.infer<typeof CreateChannelBindingResponseSchema>;
export type DeleteChannelBindingResponse = z.infer<typeof DeleteChannelBindingResponseSchema>;
export type UpdateChannelBindingResponse = z.infer<typeof UpdateChannelBindingResponseSchema>;
