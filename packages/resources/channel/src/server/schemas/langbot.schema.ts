import { PaginationParamsSchema, WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * `/web/channels/langbot` 的协议 schema。
 *
 * 两类约束在这里落地：
 * 1. **`config` 只校验形状与体积**：结构由 LangBot 适配器决定，平台不做逐适配器推断；上限按 UTF-8
 *    字节数（64 KiB）而不是字符数，避免多字节平台凭据绕过限制。
 * 2. **`config` 不出现在任何响应 schema 里**：响应类型即白名单，多带字段会在 Elysia 的响应校验处失败，
 *    而不是悄悄泄漏给浏览器。
 */

const MAX_BOT_CONFIG_BYTES = 64 * 1024;

/** Bot `config` 的最大体积判定；序列化失败（理论上只有循环引用）按超限处理。 */
function withinConfigLimit(value: Record<string, unknown>): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_BOT_CONFIG_BYTES;
  } catch {
    return false;
  }
}

export const BotConfigSchema = z
  .record(z.string(), z.unknown())
  .refine(withinConfigLimit, { message: "config 不能超过 64 KiB（UTF-8）" });

export const BotCreateBodySchema = z.object({
  name: z.string().trim().min(1).max(128).describe("Bot 名称；同时作为平台通道的展示名。"),
  adapter: z.string().trim().min(1).max(64).describe("LangBot 适配器标识，例如 `telegram` / `feishu`。"),
  config: BotConfigSchema.describe("适配器配置；只透传给 LangBot，不落库、不回显。"),
});

export const BotUpdateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(128).optional(),
    adapter: z.string().trim().min(1).max(64).optional(),
    config: BotConfigSchema.optional(),
  })
  .refine((value) => value.name !== undefined || value.adapter !== undefined || value.config !== undefined, {
    message: "至少提供一个要更新的字段",
  });

export const TestSendBodySchema = z.object({
  targetType: z.enum(["person", "group"]).describe("发送目标类型。"),
  targetId: z.string().trim().min(1).max(256).describe("IM 用户 ID 或群 ID。"),
  text: z.string().min(1).max(10_000).describe("要发送的纯文本内容。"),
});

export const RouteCreateBodySchema = z.object({
  channelId: z.string().uuid().describe("平台通道 ID。"),
  chatType: z.enum(["person", "group"]).describe("聊天类型。"),
  chatId: z.string().trim().min(1).max(256).optional().describe("IM 用户 ID 或群 ID；不传表示该类型的通配路由。"),
  agentConfigId: z.string().uuid().describe("目标 Agent 配置；必须对通道所有者可见且可 `use`。"),
  enabled: z.boolean().optional().describe("是否参与匹配，默认 true。"),
});

export const RouteUpdateBodySchema = z
  .object({
    chatType: z.enum(["person", "group"]).optional(),
    chatId: z.string().trim().min(1).max(256).nullable().optional().describe("传 null 表示改为通配路由。"),
    agentConfigId: z.string().uuid().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "至少提供一个要更新的字段" });

export const RouteListQuerySchema = z.object({
  channelId: z.string().uuid().optional().describe("只返回该通道下的路由。"),
});

export const ConversationListQuerySchema = PaginationParamsSchema.extend({
  channelId: z.string().uuid().optional().describe("只返回该通道下的会话。"),
});

export const BotUuidParamsSchema = z.object({ botUuid: z.string().uuid().describe("LangBot Bot UUID。") });
export const RouteIdParamsSchema = z.object({ id: z.string().uuid().describe("路由行 ID。") });

export const LangBotStatusViewSchema = z.object({
  reachable: z.boolean(),
  version: z.string().nullable(),
  edition: z.string().nullable(),
  wizardStatus: z.string().nullable(),
});

export const BotViewSchema = z.object({
  botUuid: z.string().nullable(),
  name: z.string(),
  adapter: z.string().nullable(),
  channelId: z.string().nullable(),
  channelName: z.string().nullable(),
  status: z.string().nullable(),
  boundRouteCount: z.number().int().nonnegative(),
  missingInLangbot: z.boolean(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const RouteViewSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  chatType: z.string(),
  chatId: z.string().nullable(),
  agentConfigId: z.string(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ConversationViewSchema = z.object({
  id: z.string(),
  channelId: z.string(),
  chatType: z.string(),
  chatId: z.string(),
  agentConfigId: z.string(),
  sessionId: z.string(),
  lastEventAt: z.string().nullable(),
  lastReplyAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ConversationPageViewSchema = z.object({
  items: z.array(ConversationViewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});

export const LangBotStatusResponseSchema = WebOkSchema(LangBotStatusViewSchema);
export const BotViewResponseSchema = WebOkSchema(BotViewSchema);
export const BotListViewResponseSchema = WebOkSchema(z.array(BotViewSchema));
export const RouteViewResponseSchema = WebOkSchema(RouteViewSchema);
export const RouteListViewResponseSchema = WebOkSchema(z.array(RouteViewSchema));
export const ConversationPageResponseSchema = WebOkSchema(ConversationPageViewSchema);
export const OkResponseSchema = WebOkSchema(z.object({ ok: z.literal(true) }));

export type BotCreateBody = z.infer<typeof BotCreateBodySchema>;
export type BotUpdateBody = z.infer<typeof BotUpdateBodySchema>;
export type TestSendBody = z.infer<typeof TestSendBodySchema>;
export type RouteCreateBody = z.infer<typeof RouteCreateBodySchema>;
export type RouteUpdateBody = z.infer<typeof RouteUpdateBodySchema>;
