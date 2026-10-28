import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { LangBotChatType, LangBotRoute } from "../../../api/langbot";

/** 路由表单的通道选项：只包含平台已有通道记录的行。 */
export interface ChannelOption {
  readonly channelId: string;
  readonly name: string;
}

export interface AgentOption {
  readonly id: string;
  readonly name: string;
}

export interface RouteFormValue {
  readonly channelId: string;
  readonly chatType: LangBotChatType;
  readonly chatId: string;
  readonly agentConfigId: string;
  readonly enabled: boolean;
}

interface RouteFormDialogProps {
  readonly open: boolean;
  readonly mode: "create" | "edit";
  readonly route: LangBotRoute | null;
  /** 从某个通道分组点「添加路由」时预选该通道。 */
  readonly presetChannelId?: string;
  readonly channels: readonly ChannelOption[];
  readonly agents: readonly AgentOption[];
  readonly agentsLoading: boolean;
  readonly agentsError: unknown;
  readonly saving: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (value: RouteFormValue) => void;
}

/** 聊天类型只有两种；后端返回的字符串按 `group` 之外一律视为私聊，避免脏值卡死表单。 */
function toChatType(value: string | undefined): LangBotChatType {
  return value === "group" ? "group" : "person";
}

/**
 * 新建 / 编辑路由的弹窗。
 *
 * 通道在编辑时不可改：路由归属由 `channelId` 决定，迁移一条路由等同于新建 + 删除；
 * `chatId` 留空即通配，编辑时清空会显式提交 `null`（后端以此表达「改为通配」）。
 */
export function RouteFormDialog(props: RouteFormDialogProps) {
  const { t } = useTranslation(NS.CHANNELS);
  const { mode, route, channels, agents } = props;
  const [channelId, setChannelId] = useState(route?.channelId ?? props.presetChannelId ?? channels[0]?.channelId ?? "");
  const [chatType, setChatType] = useState<LangBotChatType>(toChatType(route?.chatType));
  const [chatId, setChatId] = useState(route?.chatId ?? "");
  const [agentConfigId, setAgentConfigId] = useState(route?.agentConfigId ?? agents[0]?.id ?? "");
  const [enabled, setEnabled] = useState(route?.enabled ?? true);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!channelId) {
      setError(t("langbot.routes.form.channelRequired"));
      return;
    }
    if (!agentConfigId) {
      setError(t("langbot.routes.form.agentRequired"));
      return;
    }
    setError(null);
    props.onSubmit({ channelId, chatType, chatId: chatId.trim(), agentConfigId, enabled });
  };

  return (
    <FormDialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) setError(null);
        props.onOpenChange(open);
      }}
      title={t(mode === "create" ? "langbot.routes.form.createTitle" : "langbot.routes.form.editTitle")}
      onSubmit={handleSubmit}
      loading={props.saving}
      disabled={agents.length === 0 || Boolean(props.agentsError)}
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="channel-route-channel">{t("langbot.routes.form.channel")}</Label>
          <select
            id="channel-route-channel"
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
            value={channelId}
            onChange={(event) => setChannelId(event.target.value)}
            disabled={mode === "edit"}
          >
            <option value="">{t("langbot.routes.form.channelPlaceholder")}</option>
            {channels.map((channel) => (
              <option key={channel.channelId} value={channel.channelId}>
                {channel.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <Label htmlFor="channel-route-chat-type">{t("langbot.routes.form.chatType")}</Label>
          <select
            id="channel-route-chat-type"
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
            value={chatType}
            onChange={(event) => setChatType(toChatType(event.target.value))}
          >
            <option value="person">{t("langbot.routes.chatTypePerson")}</option>
            <option value="group">{t("langbot.routes.chatTypeGroup")}</option>
          </select>
        </div>

        <div>
          <Label htmlFor="channel-route-chat-id">{t("langbot.routes.form.chatId")}</Label>
          <Input
            id="channel-route-chat-id"
            className="mt-1"
            value={chatId}
            onChange={(event) => setChatId(event.target.value)}
            placeholder={t("langbot.routes.wildcard")}
          />
          <p className="mt-1 text-xs text-text-dim">{t("langbot.routes.form.chatIdHint")}</p>
        </div>

        <div>
          <Label htmlFor="channel-route-agent">{t("langbot.routes.form.agent")}</Label>
          <select
            id="channel-route-agent"
            className="mt-1 h-9 w-full rounded-md border border-input bg-background px-3 text-sm disabled:opacity-50"
            value={agentConfigId}
            onChange={(event) => setAgentConfigId(event.target.value)}
            disabled={agents.length === 0 || Boolean(props.agentsError)}
          >
            <option value="">{t("langbot.routes.form.agentPlaceholder")}</option>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
          {props.agentsError ? (
            <p className="mt-1 text-xs text-destructive" role="alert">
              {t("langbot.routes.form.agentListFailed")}
            </p>
          ) : null}
          {!props.agentsLoading && agents.length === 0 && !props.agentsError ? (
            <p className="mt-1 text-xs text-destructive">{t("langbot.routes.form.noAgents")}</p>
          ) : null}
          <p className="mt-1 text-xs text-text-dim">{t("langbot.routes.form.agentHint")}</p>
        </div>

        {mode === "create" ? (
          // 编辑时的启用状态只走列表里的「启用 / 停用」动作（停用带二次确认）：同一件事不在表单里再开一条
          // 无确认的路径，否则确认框只挡住了一半入口。
          <label className="flex items-center gap-2 text-sm text-text-secondary">
            <input
              type="checkbox"
              className="size-4 accent-blue-500"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />
            {t("langbot.routes.form.enabled")}
          </label>
        ) : null}

        {error ? (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </FormDialog>
  );
}
