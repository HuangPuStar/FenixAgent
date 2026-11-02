import { agentApi } from "@fenix/agent-config/web";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { AlertTriangle, MessageSquare, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type LangBotBot,
  type LangBotCreateBotInput,
  type LangBotCreateRouteInput,
  type LangBotRoute,
  type LangBotTestSendInput,
  type LangBotUpdateBotInput,
  type LangBotUpdateRouteInput,
  langbotApi,
} from "../../../api/langbot";
import { formatDateTime, groupRoutesByChannel, resolveChannelListViewState } from "../../../lib/channel-page-state";
import { BotFormDialog, type BotFormValue } from "../components/bot-form-dialog";
import { BotTreeRow } from "../components/bot-tree-row";
import {
  type AgentOption,
  type ChannelOption,
  RouteFormDialog,
  type RouteFormValue,
} from "../components/route-form-dialog";
import { TestSendDialog } from "../components/test-send-dialog";

interface BotEditorState {
  readonly mode: "create" | "edit";
  readonly bot: LangBotBot | null;
}

interface RouteEditorState {
  readonly mode: "create" | "edit";
  readonly route: LangBotRoute | null;
  readonly presetChannelId?: string;
}

/** 树的父行 key 与展开状态共用同一口径：channelId 是通道归属，缺失时才退回 Bot 标识。 */
function botTreeKey(bot: LangBotBot): string {
  return bot.channelId ?? bot.botUuid ?? bot.name;
}

/**
 * 通道与路由的合并视图：机器人是父行，路由缩进挂在各自通道下。
 *
 * 一个通道的所有路由都随它一起出现，用户不需要在两个页签之间对照 channelId；
 * 取数仍只有一处，避免父行的路由数与子行内容来自两次不同的请求。
 */
export function ChannelBotsView() {
  const { t, i18n } = useTranslation(NS.CHANNELS);

  const dataRequest = useRequest(() =>
    Promise.all([unwrap(langbotApi.listBots()), unwrap(langbotApi.listRoutes())]).then(([bots, routes]) => ({
      bots,
      routes,
    })),
  );
  const agentsRequest = useRequest(() => unwrap(agentApi.list()).then((result) => result.agents));

  const bots = dataRequest.data?.bots ?? [];
  const routes = dataRequest.data?.routes ?? [];
  const agents = agentsRequest.data;
  const viewState = resolveChannelListViewState({
    loading: dataRequest.loading,
    error: dataRequest.error,
    itemCount: bots.length,
  });

  const agentOptions = useMemo<AgentOption[]>(
    () => (agents ?? []).map((agent) => ({ id: agent.id, name: agent.name })),
    [agents],
  );
  const agentNames = useMemo(() => new Map(agentOptions.map((agent) => [agent.id, agent.name])), [agentOptions]);

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

  // 复用路由分组，父行的路由数与子行内容取自同一份归属，不在渲染时各自再过滤一遍。
  const routesByChannel = useMemo(() => {
    const map = new Map<string, readonly LangBotRoute[]>();
    for (const group of groupRoutesByChannel(routes, bots)) map.set(group.channelId, group.routes);
    return map;
  }, [routes, bots]);

  // null 表示尚未交互：数据到达即全部展开，首次收起时才把默认状态固化成集合。
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string> | null>(null);
  const isExpanded = (bot: LangBotBot) => expandedKeys === null || expandedKeys.has(botTreeKey(bot));
  const toggleExpanded = (bot: LangBotBot) => {
    const key = botTreeKey(bot);
    setExpandedKeys((current) => {
      const next = new Set(current ?? bots.map(botTreeKey));
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const [editor, setEditor] = useState<BotEditorState | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<LangBotBot | null>(null);
  const [testTarget, setTestTarget] = useState<LangBotBot | null>(null);
  const [routeEditor, setRouteEditor] = useState<RouteEditorState | null>(null);
  const [routeEditorKey, setRouteEditorKey] = useState(0);
  const [routeDeleteTarget, setRouteDeleteTarget] = useState<LangBotRoute | null>(null);
  const [routeDisableTarget, setRouteDisableTarget] = useState<LangBotRoute | null>(null);

  const createBotRequest = useRequest((input: LangBotCreateBotInput) => unwrap(langbotApi.createBot(input)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.bots.created"));
      setEditor(null);
      dataRequest.refresh();
    },
    onError: (error) => {
      console.error("Failed to create channel bot", error);
      toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
    },
  });

  const updateBotRequest = useRequest(
    (input: { botUuid: string; body: LangBotUpdateBotInput }) =>
      unwrap(langbotApi.updateBot(input.botUuid, input.body)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("langbot.bots.updated"));
        setEditor(null);
        dataRequest.refresh();
      },
      onError: (error) => {
        console.error("Failed to update channel bot", error);
        toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
      },
    },
  );

  const deleteBotRequest = useRequest((botUuid: string) => unwrap(langbotApi.deleteBot(botUuid)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.bots.deleted"));
      setDeleteTarget(null);
      dataRequest.refresh();
    },
    onError: (error) => {
      console.error("Failed to delete channel bot", error);
      toast.error(t("langbot.common.deleteFailedWith", { message: error.message }));
    },
  });

  const sendRequest = useRequest(
    (input: { botUuid: string; body: LangBotTestSendInput }) => unwrap(langbotApi.testSend(input.botUuid, input.body)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("langbot.bots.test.success"));
        setTestTarget(null);
        dataRequest.refresh();
      },
      onError: (error) => {
        console.error("Failed to send test message", error);
        toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
      },
    },
  );

  const createRouteRequest = useRequest((input: LangBotCreateRouteInput) => unwrap(langbotApi.createRoute(input)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.routes.created"));
      setRouteEditor(null);
      dataRequest.refresh();
    },
    onError: (error) => {
      console.error("Failed to create channel route", error);
      toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
    },
  });

  const updateRouteRequest = useRequest(
    (input: { id: string; body: LangBotUpdateRouteInput }) => unwrap(langbotApi.updateRoute(input.id, input.body)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("langbot.routes.updated"));
        setRouteEditor(null);
        setRouteDisableTarget(null);
        dataRequest.refresh();
      },
      onError: (error) => {
        console.error("Failed to update channel route", error);
        toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
      },
    },
  );

  const deleteRouteRequest = useRequest((id: string) => unwrap(langbotApi.deleteRoute(id)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.routes.deleted"));
      setRouteDeleteTarget(null);
      dataRequest.refresh();
    },
    onError: (error) => {
      console.error("Failed to delete channel route", error);
      toast.error(t("langbot.common.deleteFailedWith", { message: error.message }));
    },
  });

  const openCreateBot = () => {
    setEditorKey((key) => key + 1);
    setEditor({ mode: "create", bot: null });
  };

  const openEditBot = (bot: LangBotBot) => {
    setEditorKey((key) => key + 1);
    setEditor({ mode: "edit", bot });
  };

  const openCreateRoute = (presetChannelId?: string) => {
    setRouteEditorKey((key) => key + 1);
    setRouteEditor({ mode: "create", route: null, presetChannelId });
  };

  const openEditRoute = (route: LangBotRoute) => {
    setRouteEditorKey((key) => key + 1);
    setRouteEditor({ mode: "edit", route });
  };

  const handleBotSubmit = (value: BotFormValue) => {
    if (!editor) return;
    if (editor.mode === "create") {
      createBotRequest.run({ name: value.name, adapter: value.adapter, config: value.config ?? {} });
      return;
    }
    if (!editor.bot?.botUuid) return;
    updateBotRequest.run({
      botUuid: editor.bot.botUuid,
      body: {
        name: value.name,
        adapter: value.adapter,
        ...(value.config ? { config: value.config } : {}),
      },
    });
  };

  const handleRouteSubmit = (value: RouteFormValue) => {
    if (!routeEditor) return;
    if (routeEditor.mode === "create") {
      createRouteRequest.run({
        channelId: value.channelId,
        chatType: value.chatType,
        ...(value.chatId ? { chatId: value.chatId } : {}),
        agentConfigId: value.agentConfigId,
        enabled: value.enabled,
      });
      return;
    }
    if (!routeEditor.route) return;
    updateRouteRequest.run({
      id: routeEditor.route.id,
      body: {
        chatType: value.chatType,
        // 清空聊天 ID 的语义是「改为通配」，必须显式提交 null；省略字段会被后端当作未修改。
        chatId: value.chatId ? value.chatId : null,
        agentConfigId: value.agentConfigId,
        enabled: value.enabled,
      },
    });
  };

  // 空态分支会提前 return，弹窗必须在这里先构造再随各分支一起渲染；否则空态点的「创建」只改 state、看不到表单。
  const editorDialog = editor ? (
    <BotFormDialog
      key={editorKey}
      open
      mode={editor.mode}
      bot={editor.bot}
      saving={createBotRequest.loading || updateBotRequest.loading}
      onOpenChange={(open) => {
        if (!open) setEditor(null);
      }}
      onSubmit={handleBotSubmit}
    />
  ) : null;

  const routeEditorDialog = routeEditor ? (
    <RouteFormDialog
      key={routeEditorKey}
      open
      mode={routeEditor.mode}
      route={routeEditor.route}
      presetChannelId={routeEditor.presetChannelId}
      channels={channelOptions}
      agents={agentOptions}
      agentsLoading={agentsRequest.loading}
      agentsError={agentsRequest.error}
      saving={createRouteRequest.loading || updateRouteRequest.loading}
      onOpenChange={(open) => {
        if (!open) setRouteEditor(null);
      }}
      onSubmit={handleRouteSubmit}
    />
  ) : null;

  // 加载骨架：首屏没有数据时才展示，已有数据的刷新失败不会把树替换掉。
  if (viewState === "loading") {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-9 w-48" />
        <Skeleton className="h-56 w-full" />
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
        description={dataRequest.error?.message}
        action={{
          label: t("langbot.common.retry"),
          onClick: dataRequest.refresh,
          icon: <RefreshCw />,
          disabled: dataRequest.loading,
        }}
      />
    );
  }

  if (viewState === "empty") {
    return (
      <>
        <EmptyState
          icon={<MessageSquare />}
          title={t("langbot.bots.emptyTitle")}
          description={t("langbot.bots.emptyDescription")}
          action={{ label: t("langbot.bots.create"), onClick: openCreateBot, icon: <Plus /> }}
        />
        {editorDialog}
      </>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={dataRequest.refresh} disabled={dataRequest.loading}>
          <RefreshCw />
          {t("langbot.common.refresh")}
        </Button>
        <Button size="sm" onClick={openCreateBot}>
          <Plus />
          {t("langbot.bots.create")}
        </Button>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface-1">
        <ul>
          {bots.map((bot) => {
            const botRoutes = bot.channelId ? (routesByChannel.get(bot.channelId) ?? []) : [];
            return (
              <BotTreeRow
                key={bot.botUuid ?? bot.channelId ?? bot.name}
                bot={bot}
                routes={botRoutes}
                agentNames={agentNames}
                expanded={isExpanded(bot)}
                createdAtLabel={formatDateTime(bot.createdAt, i18n.language)}
                routeUpdating={updateRouteRequest.loading}
                onToggle={() => toggleExpanded(bot)}
                onAddRoute={() => {
                  if (bot.channelId) openCreateRoute(bot.channelId);
                }}
                onTestSend={() => setTestTarget(bot)}
                onEditBot={() => openEditBot(bot)}
                onDeleteBot={() => setDeleteTarget(bot)}
                onEditRoute={openEditRoute}
                onEnableRoute={(route) => updateRouteRequest.run({ id: route.id, body: { enabled: true } })}
                onDisableRoute={setRouteDisableTarget}
                onDeleteRoute={setRouteDeleteTarget}
              />
            );
          })}
        </ul>
      </div>

      {editorDialog}
      {routeEditorDialog}

      <TestSendDialog
        key={testTarget?.botUuid ?? "no-target"}
        open={testTarget !== null}
        bot={testTarget}
        sending={sendRequest.loading}
        onOpenChange={(open) => {
          if (!open) setTestTarget(null);
        }}
        onSubmit={(value) => {
          if (testTarget?.botUuid) sendRequest.run({ botUuid: testTarget.botUuid, body: value });
        }}
      />

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("langbot.bots.deleteTitle")}
        description={t("langbot.bots.deleteDescription")}
        confirmLabel={t("langbot.bots.delete")}
        variant="destructive"
        loading={deleteBotRequest.loading}
        onConfirm={() => {
          if (deleteTarget?.botUuid) deleteBotRequest.run(deleteTarget.botUuid);
        }}
      />

      <ConfirmDialog
        open={routeDeleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRouteDeleteTarget(null);
        }}
        title={t("langbot.routes.deleteTitle")}
        description={t("langbot.routes.deleteDescription")}
        confirmLabel={t("langbot.common.delete")}
        variant="destructive"
        loading={deleteRouteRequest.loading}
        onConfirm={() => {
          if (routeDeleteTarget) deleteRouteRequest.run(routeDeleteTarget.id);
        }}
      />

      <ConfirmDialog
        open={routeDisableTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRouteDisableTarget(null);
        }}
        title={t("langbot.routes.disableTitle")}
        description={t("langbot.routes.disableDescription")}
        confirmLabel={t("langbot.routes.disable")}
        loading={updateRouteRequest.loading}
        onConfirm={() => {
          if (routeDisableTarget) updateRouteRequest.run({ id: routeDisableTarget.id, body: { enabled: false } });
        }}
      />
    </div>
  );
}
