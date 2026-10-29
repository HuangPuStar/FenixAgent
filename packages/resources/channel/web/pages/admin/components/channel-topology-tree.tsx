/**
 * 管理台的通道拓扑树：组织 → 用户 → 通道 → 实例。
 *
 * 视觉与观察中心的归属树一致（原生 `<details>` 逐层钻取 + 缩进色条 + 等宽 id 小字），但组件**刻意在包内
 * 重写**而不是从 `@fenix/resource-observer/web` 导入：那是另一个资源包的浏览器面，把它拉进通道页会让
 * 「改观察台的树」变成「改通道页」的隐式耦合，而两者只是长得像，节点语义与字段完全不同。
 *
 * 用 `<details>/<summary>` 而不是自绘展开状态：键盘与读屏器天然可用，默认 `open` 让排障者一进来就看到
 * 实例而不是逐层点开。
 */

import { Badge } from "@fenix/ui-components/ui/badge";
import { Building2, Cpu, MessageSquare, User } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ChannelAdminChannel,
  ChannelAdminInstance,
  ChannelAdminOrganization,
  ChannelAdminUser,
} from "../../../api/admin";
import { CHANNELS_NS } from "../../../i18n/namespace";
import { formatDateTime } from "../../../lib/channel-page-state";

/** 每层 icon 与子树连接线颜色：层级一眼区分（org→user→channel→instance）。 */
const LEVEL_COLOR = {
  org: "text-brand",
  orgLine: "border-brand/30",
  user: "text-accent-tiffany",
  userLine: "border-accent-tiffany/30",
  channel: "text-accent-green",
  channelLine: "border-accent-green/30",
  instance: "text-accent-yellow",
} as const;

/** 原始 id 弱化小字配方：等宽 + 10px + muted，与观察台同一套观感。 */
const META_CLASS = "font-mono text-3xs text-text-muted";

/** 已知状态走字典；未知状态原样展示，不拼一个取不到的 key 回显到界面上。 */
const CHANNEL_STATUS_KEYS: Record<string, string> = {
  connected: "langbot.bots.status.connected",
  disconnected: "langbot.bots.status.disconnected",
  error: "langbot.bots.status.error",
};

function NodeTitle({ display, id }: { display: string; id: string }) {
  return (
    <span className="min-w-0">
      <span className="font-mono text-text-primary">{display}</span>
      {display !== id ? <span className={`ml-1 ${META_CLASS}`}>{id}</span> : null}
    </span>
  );
}

function InstanceRow({ instance }: { instance: ChannelAdminInstance }) {
  const { t, i18n } = useTranslation(CHANNELS_NS);
  return (
    <li
      data-testid="channel-instance-row"
      className="flex flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent"
    >
      <Cpu className={`size-3.5 shrink-0 ${LEVEL_COLOR.instance}`} aria-hidden="true" />
      <span className="font-mono text-text-primary">{instance.instanceName}</span>
      <span className={META_CLASS}>
        {instance.chatType === "group" ? t("langbot.routes.chatTypeGroup") : t("langbot.routes.chatTypePerson")}
      </span>
      <span className={META_CLASS} title={instance.chatId}>
        {instance.chatId}
      </span>
      <span className={META_CLASS} title={t("langbot.admin.agent")}>
        {instance.agentConfigId}
      </span>
      <span className={META_CLASS} title={t("langbot.admin.session")}>
        {instance.sessionId}
      </span>
      <span className="ml-auto shrink-0 text-3xs text-text-muted">
        {t("langbot.admin.lastEventAt")}:{" "}
        {formatDateTime(instance.lastEventAt, i18n.language) ?? t("langbot.common.never")}
        {" · "}
        {t("langbot.admin.lastReplyAt")}:{" "}
        {formatDateTime(instance.lastReplyAt, i18n.language) ?? t("langbot.common.never")}
      </span>
    </li>
  );
}

function ChannelNode({ channel }: { channel: ChannelAdminChannel }) {
  const { t } = useTranslation(CHANNELS_NS);
  const statusLabel = CHANNEL_STATUS_KEYS[channel.status];
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-2 py-1 text-xs hover:bg-accent">
          <MessageSquare className={`size-3.5 shrink-0 ${LEVEL_COLOR.channel}`} aria-hidden="true" />
          <NodeTitle display={channel.name} id={channel.id} />
          {channel.adapter ? (
            <Badge variant="outline" className="text-3xs">
              {channel.adapter}
            </Badge>
          ) : null}
          <Badge variant="secondary" className="text-3xs">
            {statusLabel ? t(statusLabel) : channel.status}
          </Badge>
          {channel.botUuid ? (
            <span className={META_CLASS} title={t("langbot.admin.botUuid")}>
              {channel.botUuid}
            </span>
          ) : null}
        </summary>
        <ul className={`ml-4 border-l py-1 pl-2 ${LEVEL_COLOR.channelLine}`}>
          {channel.instances.length === 0 ? (
            <li className="px-2 text-xs text-text-muted">{t("langbot.admin.instancesEmpty")}</li>
          ) : (
            channel.instances.map((instance) => <InstanceRow key={instance.conversationId} instance={instance} />)
          )}
        </ul>
      </details>
    </li>
  );
}

function UserNode({ user }: { user: ChannelAdminUser }) {
  return (
    <li>
      <details open>
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-accent">
          <User className={`size-3.5 shrink-0 ${LEVEL_COLOR.user}`} aria-hidden="true" />
          <NodeTitle display={user.name} id={user.id} />
          {user.email ? <span className={META_CLASS}>{user.email}</span> : null}
        </summary>
        <ul className={`ml-4 border-l pl-2 ${LEVEL_COLOR.userLine}`}>
          {user.channels.map((channel) => (
            <ChannelNode key={channel.id} channel={channel} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function ChannelTopologyTree({ organizations }: { organizations: readonly ChannelAdminOrganization[] }) {
  return (
    <ul className="space-y-1" data-testid="channel-topology-tree">
      {organizations.map((organization) => (
        <li key={organization.id}>
          <details open>
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-md px-2 py-1 text-sm font-medium hover:bg-accent">
              <Building2 className={`size-3.5 shrink-0 ${LEVEL_COLOR.org}`} aria-hidden="true" />
              <NodeTitle display={organization.name} id={organization.id} />
            </summary>
            <ul className={`ml-4 border-l pl-2 ${LEVEL_COLOR.orgLine}`}>
              {organization.users.map((user) => (
                <UserNode key={user.id} user={user} />
              ))}
            </ul>
          </details>
        </li>
      ))}
    </ul>
  );
}
