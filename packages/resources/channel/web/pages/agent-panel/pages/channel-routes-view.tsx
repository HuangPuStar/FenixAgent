import { agentApi } from "@fenix/agent-config/web";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import {
  AlertTriangle,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Route as RouteIcon,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type LangBotCreateRouteInput,
  type LangBotRoute,
  type LangBotUpdateRouteInput,
  langbotApi,
} from "../../../api/langbot";
import { groupRoutesByChannel, resolveChannelListViewState } from "../../../lib/channel-page-state";
import {
  type AgentOption,
  type ChannelOption,
  RouteFormDialog,
  type RouteFormValue,
} from "../components/route-form-dialog";

interface RouteEditorState {
  readonly mode: "create" | "edit";
  readonly route: LangBotRoute | null;
  readonly presetChannelId?: string;
}

interface ChannelRoutesViewProps {
  /** 没有通道时引导到「通道」视图创建，而不是让用户对着一张空表猜下一步。 */
  readonly onGoToBots: () => void;
}

/** 路由视图：按通道分组展示全部路由，并允许选 Agent 配置、填聊天 ID（留空即通配）。 */
export function ChannelRoutesView({ onGoToBots }: ChannelRoutesViewProps) {
  const { t } = useTranslation(NS.CHANNELS);
  const coreRequest = useRequest(() =>
    Promise.all([unwrap(langbotApi.listRoutes()), unwrap(langbotApi.listBots())]).then(([routes, bots]) => ({
      routes,
      bots,
    })),
  );
  const agentsRequest = useRequest(() => unwrap(agentApi.list()).then((result) => result.agents));
  const routes = coreRequest.data?.routes ?? [];
  const bots = coreRequest.data?.bots ?? [];
  const agents = agentsRequest.data ?? [];
  const groups = groupRoutesByChannel(routes, bots);
  const viewState = resolveChannelListViewState({
    loading: coreRequest.loading,
    error: coreRequest.error,
    itemCount: routes.length,
  });

  const [editor, setEditor] = useState<RouteEditorState | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<LangBotRoute | null>(null);
  const [disableTarget, setDisableTarget] = useState<LangBotRoute | null>(null);

  const channelOptions = useMemo<ChannelOption[]>(() => {
    const seen = new Set<string>();
    const options: ChannelOption[] = [];
    for (const bot of bots) {
      if (!bot.channelId || seen.has(bot.channelId)) continue;
      seen.add(bot.channelId);
      options.push({ channelId: bot.channelId, name: bot.channelName ?? bot.name });
    }
    return options;
  }, [bots]);

  const agentOptions = useMemo<AgentOption[]>(
    () => agents.map((agent) => ({ id: agent.id, name: agent.name })),
    [agents],
  );
  const agentNames = useMemo(() => new Map(agentOptions.map((agent) => [agent.id, agent.name])), [agentOptions]);

  const createRequest = useRequest((input: LangBotCreateRouteInput) => unwrap(langbotApi.createRoute(input)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.routes.created"));
      setEditor(null);
      coreRequest.refresh();
    },
    onError: (error) => {
      console.error("Failed to create channel route", error);
      toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
    },
  });

  const updateRequest = useRequest(
    (input: { id: string; body: LangBotUpdateRouteInput }) => unwrap(langbotApi.updateRoute(input.id, input.body)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("langbot.routes.updated"));
        setEditor(null);
        setDisableTarget(null);
        coreRequest.refresh();
      },
      onError: (error) => {
        console.error("Failed to update channel route", error);
        toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
      },
    },
  );

  const deleteRequest = useRequest((id: string) => unwrap(langbotApi.deleteRoute(id)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.routes.deleted"));
      setDeleteTarget(null);
      coreRequest.refresh();
    },
    onError: (error) => {
      console.error("Failed to delete channel route", error);
      toast.error(t("langbot.common.deleteFailedWith", { message: error.message }));
    },
  });

  const openCreate = (presetChannelId?: string) => {
    setEditorKey((key) => key + 1);
    setEditor({ mode: "create", route: null, presetChannelId });
  };

  const openEdit = (route: LangBotRoute) => {
    setEditorKey((key) => key + 1);
    setEditor({ mode: "edit", route });
  };

  const handleFormSubmit = (value: RouteFormValue) => {
    if (!editor) return;
    if (editor.mode === "create") {
      createRequest.run({
        channelId: value.channelId,
        chatType: value.chatType,
        ...(value.chatId ? { chatId: value.chatId } : {}),
        agentConfigId: value.agentConfigId,
        enabled: value.enabled,
      });
      return;
    }
    if (!editor.route) return;
    updateRequest.run({
      id: editor.route.id,
      body: {
        chatType: value.chatType,
        // 清空聊天 ID 的语义是「改为通配」，必须显式提交 null；省略字段会被后端当作未修改。
        chatId: value.chatId ? value.chatId : null,
        agentConfigId: value.agentConfigId,
        enabled: value.enabled,
      },
    });
  };

  const chatLabel = (route: LangBotRoute) =>
    route.chatType === "group" ? t("langbot.routes.chatTypeGroup") : t("langbot.routes.chatTypePerson");

  if (viewState === "loading") {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (viewState === "unauthorized") {
    return (
      <EmptyState
        icon={<ShieldAlert />}
        tone="danger"
        role="alert"
        title={t("langbot.common.unauthorizedTitle")}
        description={t("langbot.common.unauthorizedDescription")}
      />
    );
  }

  if (viewState === "error") {
    return (
      <EmptyState
        icon={<AlertTriangle />}
        tone="danger"
        role="alert"
        title={t("langbot.common.loadFailed")}
        description={coreRequest.error?.message}
        action={{
          label: t("langbot.common.retry"),
          onClick: coreRequest.refresh,
          icon: <RefreshCw />,
          disabled: coreRequest.loading,
        }}
      />
    );
  }

  if (viewState === "empty") {
    if (channelOptions.length === 0) {
      return (
        <EmptyState
          icon={<RouteIcon />}
          title={t("langbot.routes.noChannelsTitle")}
          description={t("langbot.routes.noChannelsDescription")}
          action={{ label: t("langbot.routes.goToBots"), onClick: onGoToBots, icon: <Plus /> }}
        />
      );
    }
    return (
      <EmptyState
        icon={<RouteIcon />}
        title={t("langbot.routes.emptyTitle")}
        description={t("langbot.routes.emptyDescription")}
        action={{ label: t("langbot.routes.create"), onClick: () => openCreate(), icon: <Plus /> }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={coreRequest.refresh} disabled={coreRequest.loading}>
          <RefreshCw />
          {t("langbot.common.refresh")}
        </Button>
        <Button size="sm" onClick={() => openCreate()} disabled={channelOptions.length === 0}>
          <Plus />
          {t("langbot.routes.create")}
        </Button>
      </div>

      {groups.map((group) => (
        <section key={group.channelId} className="overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
          <header className="flex items-center justify-between gap-3 border-b border-border-subtle bg-surface-2 px-4 py-3">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-medium text-text-bright">{group.channelName}</h3>
              <p className="truncate text-xs text-text-dim">{group.channelId}</p>
              {group.missingBot ? (
                <p className="mt-1 text-xs text-status-warning">{t("langbot.bots.missingInLangbot")}</p>
              ) : null}
            </div>
            <Button variant="outline" size="sm" onClick={() => openCreate(group.channelId)}>
              <Plus />
              {t("langbot.routes.groupAdd")}
            </Button>
          </header>

          <table className="w-full text-left text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {t("langbot.routes.table.chat")}
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {t("langbot.routes.table.agent")}
                </th>
                <th scope="col" className="px-4 py-2.5 font-medium">
                  {t("langbot.routes.table.enabled")}
                </th>
                <th scope="col" className="px-4 py-2.5 text-right font-medium">
                  {t("langbot.routes.table.actions")}
                </th>
              </tr>
            </thead>
            <tbody>
              {group.routes.map((route) => (
                <tr key={route.id} className="border-t border-border-subtle">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text-bright">
                      {chatLabel(route)}
                      <span className="ml-2 text-xs font-normal text-text-dim">
                        {route.chatId ?? t("langbot.routes.wildcard")}
                      </span>
                    </p>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {agentNames.get(route.agentConfigId) ?? route.agentConfigId}
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge
                      status={route.enabled ? "enabled" : "disabled"}
                      label={t(route.enabled ? "langbot.routes.enabled" : "langbot.routes.disabled")}
                      tone={route.enabled ? "success" : "neutral"}
                      indicator="dot"
                    />
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1">
                      {route.enabled ? (
                        <Button variant="ghost" size="sm" onClick={() => setDisableTarget(route)}>
                          <Pause />
                          {t("langbot.routes.disable")}
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={updateRequest.loading}
                          onClick={() => updateRequest.run({ id: route.id, body: { enabled: true } })}
                        >
                          <Play />
                          {t("langbot.routes.enable")}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" onClick={() => openEdit(route)}>
                        <Pencil />
                        {t("langbot.common.edit")}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(route)}>
                        <Trash2 />
                        {t("langbot.common.delete")}
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}

      {editor ? (
        <RouteFormDialog
          key={editorKey}
          open
          mode={editor.mode}
          route={editor.route}
          presetChannelId={editor.presetChannelId}
          channels={channelOptions}
          agents={agentOptions}
          agentsLoading={agentsRequest.loading}
          agentsError={agentsRequest.error}
          saving={createRequest.loading || updateRequest.loading}
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          onSubmit={handleFormSubmit}
        />
      ) : null}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("langbot.routes.deleteTitle")}
        description={t("langbot.routes.deleteDescription")}
        confirmLabel={t("langbot.common.delete")}
        variant="destructive"
        loading={deleteRequest.loading}
        onConfirm={() => {
          if (deleteTarget) deleteRequest.run(deleteTarget.id);
        }}
      />

      <ConfirmDialog
        open={disableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDisableTarget(null);
        }}
        title={t("langbot.routes.disableTitle")}
        description={t("langbot.routes.disableDescription")}
        confirmLabel={t("langbot.routes.disable")}
        loading={updateRequest.loading}
        onConfirm={() => {
          if (disableTarget) updateRequest.run({ id: disableTarget.id, body: { enabled: false } });
        }}
      />
    </div>
  );
}
