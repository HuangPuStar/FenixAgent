import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * `GET /api/system/channels` 的响应 schema。
 *
 * 这份视图只服务系统 API Key 面，字段全部是展示投影：不含 `im_channel.credentials`（Bot UUID 之外的凭据）、
 * LangBot key、完整 `rcs_session_id` 与 ACP session。响应 schema 即白名单——多带字段会在 Elysia 的响应校验
 * 处失败，而不是悄悄泄漏给浏览器。
 */

export const ChannelAdminStatusViewSchema = z.object({
  reachable: z.boolean().describe("LangBot 是否可达；未配置或探测失败时为 false。"),
  version: z.string().nullable().describe("LangBot 版本；不可达时为 null。"),
  edition: z.string().nullable().describe("LangBot 发行版；不可达时为 null。"),
  wizardStatus: z.string().nullable().describe("LangBot 初始化向导状态；不可达时为 null。"),
});

export const ChannelAdminInstanceViewSchema = z.object({
  conversationId: z.string().describe("会话映射行 ID，也是实例名的来源。"),
  instanceName: z.string().describe("派生实例名（`im-<conversationId>`），与宿主创建实例时使用的规则一致。"),
  chatType: z.enum(["person", "group"]).describe("聊天类型：私聊或群聊。"),
  chatId: z.string().describe("IM 用户 ID 或群 ID。"),
  agentConfigId: z.string().describe("该会话归属的 Agent 配置 ID；不解析名称。"),
  sessionId: z.string().describe("脱敏后的 Chat 会话键，只保留首尾片段。"),
  lastEventAt: z.string().nullable().describe("最近一次入站事件时间（ISO）；没有事件时为 null。"),
  lastReplyAt: z.string().nullable().describe("最近一次回复时间（ISO）；没有回复时为 null。"),
});

export const ChannelAdminChannelViewSchema = z.object({
  id: z.string().describe("平台通道 ID。"),
  name: z.string().describe("通道展示名（创建 Bot 时写入）。"),
  adapter: z.string().nullable().describe("LangBot Bot 的适配器标识；Bot 列表不可读时为 null。"),
  status: z.string().describe("平台记录的连接状态（connected / disconnected / error）。"),
  botUuid: z.string().nullable().describe("关联的 LangBot Bot UUID；平台行漂移时为 null。"),
  createdAt: z.string().describe("通道创建时间（ISO）。"),
  instances: ChannelAdminInstanceViewSchema.array().describe("该通道下的全部会话实例，按最近事件倒序。"),
});

export const ChannelAdminUserViewSchema = z.object({
  id: z.string().describe("通道所有者用户 ID。"),
  name: z.string().describe("用户展示名；身份目录缺名时回退为 ID。"),
  email: z.string().nullable().describe("用户邮箱；身份目录查不到时为 null。"),
  channels: ChannelAdminChannelViewSchema.array().describe("该用户拥有的通道，按创建时间升序。"),
});

export const ChannelAdminOrganizationViewSchema = z.object({
  id: z.string().describe("组织 ID。"),
  name: z.string().describe("组织名称；身份目录缺名时回退为 ID。"),
  users: ChannelAdminUserViewSchema.array().describe("拥有至少一个通道的用户，按名称升序。"),
});

export const ChannelAdminSnapshotSchema = z.object({
  status: ChannelAdminStatusViewSchema.describe("LangBot 连通性快照。"),
  organizations: ChannelAdminOrganizationViewSchema.array().describe("跨组织的通道拓扑；没有通道的组织不出现。"),
});

/** `/api/system/channels` 的成功信封；失败沿用系统 API 的 `{ error }` 形状。 */
export const ChannelAdminResponseSchema = WebOkSchema(ChannelAdminSnapshotSchema);
