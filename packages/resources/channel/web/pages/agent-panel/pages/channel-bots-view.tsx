import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge, type StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { unwrap } from "@fenix/web-runtime/api/request";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useRequest } from "ahooks";
import { AlertTriangle, MessageSquare, Pencil, Plus, RefreshCw, Send, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  type LangBotBot,
  type LangBotCreateBotInput,
  type LangBotTestSendInput,
  type LangBotUpdateBotInput,
  langbotApi,
} from "../../../api/langbot";
import { formatDateTime, resolveChannelListViewState } from "../../../lib/channel-page-state";
import { BotFormDialog, type BotFormValue } from "../components/bot-form-dialog";
import { TestSendDialog } from "../components/test-send-dialog";

const STATUS_TONES: Record<string, StatusTone> = {
  connected: "success",
  disconnected: "neutral",
  error: "danger",
};

interface BotEditorState {
  readonly mode: "create" | "edit";
  readonly bot: LangBotBot | null;
}

export function ChannelBotsView() {
  const { t, i18n } = useTranslation(NS.CHANNELS);
  const botsRequest = useRequest(() => unwrap(langbotApi.listBots()));
  const bots = botsRequest.data ?? [];
  const viewState = resolveChannelListViewState({
    loading: botsRequest.loading,
    error: botsRequest.error,
    itemCount: bots.length,
  });

  const [editor, setEditor] = useState<BotEditorState | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const [deleteTarget, setDeleteTarget] = useState<LangBotBot | null>(null);
  const [testTarget, setTestTarget] = useState<LangBotBot | null>(null);

  const createRequest = useRequest((input: LangBotCreateBotInput) => unwrap(langbotApi.createBot(input)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.bots.created"));
      setEditor(null);
      botsRequest.refresh();
    },
    onError: (error) => {
      console.error("Failed to create channel bot", error);
      toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
    },
  });

  const updateRequest = useRequest(
    (input: { botUuid: string; body: LangBotUpdateBotInput }) =>
      unwrap(langbotApi.updateBot(input.botUuid, input.body)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("langbot.bots.updated"));
        setEditor(null);
        botsRequest.refresh();
      },
      onError: (error) => {
        console.error("Failed to update channel bot", error);
        toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
      },
    },
  );

  const deleteRequest = useRequest((botUuid: string) => unwrap(langbotApi.deleteBot(botUuid)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("langbot.bots.deleted"));
      setDeleteTarget(null);
      botsRequest.refresh();
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
        botsRequest.refresh();
      },
      onError: (error) => {
        console.error("Failed to send test message", error);
        toast.error(t("langbot.common.operationFailedWith", { message: error.message }));
      },
    },
  );

  const openCreate = () => {
    setEditorKey((key) => key + 1);
    setEditor({ mode: "create", bot: null });
  };

  const openEdit = (bot: LangBotBot) => {
    setEditorKey((key) => key + 1);
    setEditor({ mode: "edit", bot });
  };

  const handleFormSubmit = (value: BotFormValue) => {
    if (!editor) return;
    if (editor.mode === "create") {
      createRequest.run({ name: value.name, adapter: value.adapter, config: value.config ?? {} });
      return;
    }
    if (!editor.bot?.botUuid) return;
    updateRequest.run({
      botUuid: editor.bot.botUuid,
      body: {
        name: value.name,
        adapter: value.adapter,
        ...(value.config ? { config: value.config } : {}),
      },
    });
  };

  // 加载骨架：首屏没有数据时才展示，已有数据的刷新失败不会把表格替换掉。
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
        description={botsRequest.error?.message}
        action={{
          label: t("langbot.common.retry"),
          onClick: botsRequest.refresh,
          icon: <RefreshCw />,
          disabled: botsRequest.loading,
        }}
      />
    );
  }

  if (viewState === "empty") {
    return (
      <EmptyState
        icon={<MessageSquare />}
        title={t("langbot.bots.emptyTitle")}
        description={t("langbot.bots.emptyDescription")}
        action={{ label: t("langbot.bots.create"), onClick: openCreate, icon: <Plus /> }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
        <Button variant="outline" size="sm" onClick={botsRequest.refresh} disabled={botsRequest.loading}>
          <RefreshCw />
          {t("langbot.common.refresh")}
        </Button>
        <Button size="sm" onClick={openCreate}>
          <Plus />
          {t("langbot.bots.create")}
        </Button>
      </div>

      <div className="overflow-hidden rounded-xl border border-border-subtle bg-surface-1">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-2 text-xs text-text-muted">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t("langbot.bots.table.name")}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t("langbot.bots.table.adapter")}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t("langbot.bots.table.status")}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t("langbot.bots.table.routes")}
              </th>
              <th scope="col" className="px-4 py-2.5 font-medium">
                {t("langbot.bots.table.createdAt")}
              </th>
              <th scope="col" className="px-4 py-2.5 text-right font-medium">
                {t("langbot.bots.table.actions")}
              </th>
            </tr>
          </thead>
          <tbody>
            {bots.map((bot) => {
              const createdAt = formatDateTime(bot.createdAt, i18n.language);
              return (
                <tr key={bot.botUuid ?? bot.channelId ?? bot.name} className="border-t border-border-subtle">
                  <td className="px-4 py-3">
                    <p className="font-medium text-text-bright">{bot.name}</p>
                    <p className="text-xs text-text-dim">{bot.botUuid ?? bot.channelId ?? "—"}</p>
                    {bot.missingInLangbot ? (
                      <p className="mt-1 text-xs text-status-warning">{t("langbot.bots.missingInLangbot")}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{bot.adapter ?? t("langbot.common.unknown")}</td>
                  <td className="px-4 py-3">
                    {bot.status ? (
                      <StatusBadge
                        status={bot.status}
                        toneMap={STATUS_TONES}
                        label={t(`langbot.bots.status.${bot.status}`, { defaultValue: bot.status })}
                        indicator="dot"
                      />
                    ) : (
                      <span className="text-text-dim">{t("langbot.common.unknown")}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">
                    {t("langbot.bots.routeCount", { total: bot.boundRouteCount })}
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{createdAt ?? t("langbot.common.never")}</td>
                  <td className="px-4 py-3">
                    {bot.botUuid ? (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => setTestTarget(bot)}>
                          <Send />
                          {t("langbot.bots.testSend")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => openEdit(bot)}>
                          <Pencil />
                          {t("langbot.bots.edit")}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => setDeleteTarget(bot)}>
                          <Trash2 />
                          {t("langbot.bots.delete")}
                        </Button>
                      </div>
                    ) : (
                      <p className="text-right text-xs text-text-dim">{t("langbot.bots.noBotUuid")}</p>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editor ? (
        <BotFormDialog
          key={editorKey}
          open
          mode={editor.mode}
          bot={editor.bot}
          saving={createRequest.loading || updateRequest.loading}
          onOpenChange={(open) => {
            if (!open) setEditor(null);
          }}
          onSubmit={handleFormSubmit}
        />
      ) : null}

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
        loading={deleteRequest.loading}
        onConfirm={() => {
          if (deleteTarget?.botUuid) deleteRequest.run(deleteTarget.botUuid);
        }}
      />
    </div>
  );
}
