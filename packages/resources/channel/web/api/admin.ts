/**
 * 系统管理面「消息通道」域模块（`/api/system/channels`）。
 *
 * 类型逐字段对应 `packages/resources/channel/src/server/schemas/channel-admin.schema.ts`：响应 schema 即
 * 白名单，凭据、LangBot key、完整 `rcs_session_id` 都不在线上形状里，前端也不得补出这些幻影字段。
 *
 * 与 `/web/channels/langbot/*`（会话认证 + active organization）是两套凭据：本模块用系统 master key，
 * 由 `AdminKeyGate` 写入 sessionStorage，401 由页面清 key 回门。
 */

import { request, unwrap } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";

/** LangBot 连通性快照；探测失败时只有 `reachable: false`，其余为 null。 */
export interface ChannelAdminStatus {
  reachable: boolean;
  version: string | null;
  edition: string | null;
  wizardStatus: string | null;
}

/** 一个 IM 聊天对应的长期实例；不查询运行状态。 */
export interface ChannelAdminInstance {
  conversationId: string;
  instanceName: string;
  chatType: "person" | "group";
  chatId: string;
  agentConfigId: string;
  /** 已脱敏的会话键。 */
  sessionId: string;
  lastEventAt: string | null;
  lastReplyAt: string | null;
}

/** 平台侧的一条 IM 通道。 */
export interface ChannelAdminChannel {
  id: string;
  name: string;
  /** LangBot Bot 的适配器标识；读不到 Bot 列表时为 null。 */
  adapter: string | null;
  status: string;
  botUuid: string | null;
  createdAt: string;
  instances: ChannelAdminInstance[];
}

/** 通道所有者；没有通道的用户不出现在拓扑里。 */
export interface ChannelAdminUser {
  id: string;
  name: string;
  email: string | null;
  channels: ChannelAdminChannel[];
}

export interface ChannelAdminOrganization {
  id: string;
  name: string;
  users: ChannelAdminUser[];
}

/** 管理页一次取全的数据。 */
export interface ChannelAdminSnapshot {
  status: ChannelAdminStatus;
  organizations: ChannelAdminOrganization[];
}

export const channelAdminApi = {
  /** 拉取跨组织通道拓扑与 LangBot 连通性（Bearer master key）。 */
  fetchSnapshot: (): Promise<ChannelAdminSnapshot> =>
    unwrap(request<ChannelAdminSnapshot>("/api/system/channels", { bearerToken: getAdminKey() ?? undefined })),
};
