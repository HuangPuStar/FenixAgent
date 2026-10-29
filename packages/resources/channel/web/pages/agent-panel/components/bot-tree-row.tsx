import { StatusBadge, type StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@fenix/ui-components/ui/tooltip";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { ChevronRight, type LucideIcon, Pause, Pencil, Play, Plus, Send, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { LangBotBot, LangBotRoute } from "../../../api/langbot";
import { AdapterIcon } from "./adapter-icons";

const STATUS_TONES: Record<string, StatusTone> = {
  connected: "success",
  disconnected: "neutral",
  error: "danger",
};

interface IconActionProps {
  readonly label: string;
  readonly icon: LucideIcon;
  readonly onClick: () => void;
  readonly disabled?: boolean;
  readonly destructive?: boolean;
}

/** 行内动作统一收成图标按钮：文案进 tooltip 与 aria-label，避免每行重复长文字挤占空间。 */
function IconAction({ label, icon: Icon, onClick, disabled, destructive }: IconActionProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={destructive ? "text-destructive hover:bg-destructive/10 hover:text-destructive" : undefined}
        >
          <Icon aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export interface BotTreeRowProps {
  readonly bot: LangBotBot;
  readonly routes: readonly LangBotRoute[];
  readonly agentNames: ReadonlyMap<string, string>;
  readonly expanded: boolean;
  /** 已格式化的创建时间；纯展示组件不承担 locale 依赖。 */
  readonly createdAtLabel: string | null;
  readonly routeUpdating: boolean;
  readonly onToggle: () => void;
  readonly onAddRoute: () => void;
  readonly onTestSend: () => void;
  readonly onEditBot: () => void;
  readonly onDeleteBot: () => void;
  readonly onEditRoute: (route: LangBotRoute) => void;
  readonly onEnableRoute: (route: LangBotRoute) => void;
  readonly onDisableRoute: (route: LangBotRoute) => void;
  readonly onDeleteRoute: (route: LangBotRoute) => void;
}

/**
 * 合并树的单条机器人行：父行是通道，展开后的缩进子行是该通道的路由。
 *
 * 只负责展示与回调派发，取数、弹窗和请求状态都在 `ChannelBotsView` 里，避免同一份状态
 * 在两次渲染之间出现分叉。
 */
export function BotTreeRow(props: BotTreeRowProps) {
  const { t } = useTranslation(NS.CHANNELS);
  const { bot, routes, expanded } = props;
  const childrenId = `channel-bot-routes-${bot.botUuid ?? bot.channelId ?? bot.name}`;

  return (
    <li className="border-t border-border-subtle first:border-t-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
        <Button
          variant="ghost"
          size="icon-sm"
          className="shrink-0"
          aria-expanded={expanded}
          // 折叠时子层不渲染，指向不存在的 id 只会误导读屏，因此有子层时才声明关联。
          aria-controls={expanded ? childrenId : undefined}
          aria-label={t(expanded ? "langbot.bots.tree.collapse" : "langbot.bots.tree.expand", { name: bot.name })}
          onClick={props.onToggle}
        >
          <ChevronRight className={cn("transition-transform", expanded && "rotate-90")} aria-hidden="true" />
        </Button>

        <AdapterIcon adapter={bot.adapter} className="size-5 shrink-0 text-text-secondary" />

        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-bright">{bot.name}</p>
          <p className="truncate text-xs text-text-dim">{bot.botUuid ?? bot.channelId ?? "—"}</p>
          {bot.missingInLangbot ? (
            <p className="mt-1 text-xs text-status-warning">{t("langbot.bots.missingInLangbot")}</p>
          ) : null}
        </div>

        <span className="text-xs text-text-secondary">{bot.adapter ?? t("langbot.common.unknown")}</span>

        {bot.status ? (
          <StatusBadge
            status={bot.status}
            toneMap={STATUS_TONES}
            label={t(`langbot.bots.status.${bot.status}`, { defaultValue: bot.status })}
            indicator="dot"
          />
        ) : (
          <span className="text-xs text-text-dim">{t("langbot.common.unknown")}</span>
        )}

        <span className="text-xs text-text-secondary">{t("langbot.bots.routeCount", { total: routes.length })}</span>
        <span className="text-xs text-text-muted">{props.createdAtLabel ?? t("langbot.common.never")}</span>

        <div className="flex flex-wrap items-center justify-end gap-1">
          <IconAction
            label={t("langbot.bots.tree.addRoute")}
            icon={Plus}
            onClick={props.onAddRoute}
            disabled={!bot.channelId}
          />
          {bot.botUuid ? (
            <>
              <IconAction label={t("langbot.bots.testSend")} icon={Send} onClick={props.onTestSend} />
              <IconAction label={t("langbot.bots.edit")} icon={Pencil} onClick={props.onEditBot} />
              <IconAction label={t("langbot.bots.delete")} icon={Trash2} onClick={props.onDeleteBot} destructive />
            </>
          ) : (
            <span className="self-center text-xs text-text-dim">{t("langbot.bots.noBotUuid")}</span>
          )}
        </div>
      </div>

      {expanded ? (
        <div id={childrenId} className="ml-10 border-l border-border-subtle pb-3 pl-3 pr-4">
          {routes.length === 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
              <p className="text-xs text-text-muted">{t("langbot.bots.tree.routesEmpty")}</p>
              <Button variant="ghost" size="sm" onClick={props.onAddRoute} disabled={!bot.channelId}>
                <Plus aria-hidden="true" />
                {t("langbot.bots.tree.addRoute")}
              </Button>
            </div>
          ) : (
            <ul className="space-y-1">
              {routes.map((route) => (
                <li key={route.id} className="rounded-lg bg-surface-2 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-text-bright">
                        {route.chatType === "group"
                          ? t("langbot.routes.chatTypeGroup")
                          : t("langbot.routes.chatTypePerson")}
                        <span className="ml-2 text-xs text-text-dim">
                          {route.chatId ?? t("langbot.routes.wildcard")}
                        </span>
                      </p>
                      <p className="truncate text-xs text-text-dim">
                        <span className="text-text-muted">{t("langbot.bots.tree.agent")}</span>
                        {" · "}
                        {props.agentNames.get(route.agentConfigId) ?? route.agentConfigId}
                      </p>
                      {/* 停用路由没有在收听，说「尚未创建」会被误读成从没配置过。 */}
                      {route.enabled ? (
                        <p className="truncate text-xs text-text-dim">
                          <span className="text-text-muted">{t("langbot.bots.tree.instances")}</span>
                          {" · "}
                          {route.instances.length > 1
                            ? `${route.instances[0]!.instanceName} ${t("langbot.bots.tree.instancesMore", { count: route.instances.length - 1 })}`
                            : (route.instances[0]?.instanceName ?? t("langbot.bots.tree.instancesEmpty"))}
                        </p>
                      ) : null}
                    </div>

                    <StatusBadge
                      status={route.enabled ? "enabled" : "disabled"}
                      label={t(route.enabled ? "langbot.routes.enabled" : "langbot.routes.disabled")}
                      tone={route.enabled ? "success" : "neutral"}
                      indicator="dot"
                    />

                    <div className="flex flex-wrap items-center justify-end gap-1">
                      {route.enabled ? (
                        <IconAction
                          label={t("langbot.routes.disable")}
                          icon={Pause}
                          onClick={() => props.onDisableRoute(route)}
                        />
                      ) : (
                        <IconAction
                          label={t("langbot.routes.enable")}
                          icon={Play}
                          onClick={() => props.onEnableRoute(route)}
                          disabled={props.routeUpdating}
                        />
                      )}
                      <IconAction
                        label={t("langbot.common.edit")}
                        icon={Pencil}
                        onClick={() => props.onEditRoute(route)}
                      />
                      <IconAction
                        label={t("langbot.common.delete")}
                        icon={Trash2}
                        onClick={() => props.onDeleteRoute(route)}
                        destructive
                      />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </li>
  );
}
