import { useRequest } from "ahooks";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { channelApi } from "@/src/api/channels";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

type ChannelBinding = {
  id: string;
  platform: string;
  chatId: string | null;
  agentId: string;
  enabled: boolean;
  agentName?: string | null;
};

type EnvironmentSummary = { id: string; name: string };

export function AgentChannelsPage() {
  const { t } = useTranslation("channels");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [formPlatform, setFormPlatform] = useState("");
  const [formChatId, setFormChatId] = useState("");
  const [formAgentId, setFormAgentId] = useState("");

  // 列表查询：并行拉取通道绑定 + 环境汇总
  const {
    data: listData,
    loading,
    refresh,
  } = useRequest(() => Promise.all([unwrap(channelApi.listBindings()), unwrap(envApi.list())]), {
    onError: (err) => {
      console.error("Failed to load channels", err);
      toast.error(t("loadBindingsFailed"));
    },
  });
  const bindings: ChannelBinding[] = Array.isArray(listData?.[0]) ? listData[0] : [];
  const environments: EnvironmentSummary[] = Array.isArray(listData?.[1]) ? listData[1] : [];

  // 创建绑定：仅成功时 toast 提示
  const { run: runCreate, loading: formSaving } = useRequest(
    (platform: string, chatId: string, agentId: string) =>
      unwrap(channelApi.createBinding({ platform: platform.trim(), chatId: chatId.trim() || "", agentId })),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.created"));
        setDialogOpen(false);
        refresh();
      },
      onError: (err) => {
        console.error("Save failed", err);
        toast.error(t("toast.saveFailed"));
      },
    },
  );

  // 删除绑定：静默操作
  const { run: runDelete } = useRequest((id: string) => unwrap(channelApi.deleteBinding({ id })), {
    manual: true,
    onSuccess: () => {
      setConfirmOpen(false);
      setDeleteTarget(null);
      refresh();
    },
    onError: (err) => {
      console.error("Delete failed", err);
      toast.error(t("toast.deleteFailed"));
    },
  });

  const handleCreate = () => {
    setFormPlatform("");
    setFormChatId("");
    setFormAgentId(environments[0]?.id ?? "");
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!formPlatform.trim() || !formAgentId) {
      toast.error(t("validation.required"));
      return;
    }
    runCreate(formPlatform, formChatId, formAgentId);
  };

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-[22px] w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
        <div className="mb-3.5 h-px bg-[#e8edf4]" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={<Button onClick={handleCreate}>{t("btn.create")}</Button>}
      />
      <AgentCardList
        items={bindings}
        cardKey={(b) => b.id}
        searchPlaceholder={t("searchPlaceholder")}
        searchFn={(b, q) => b.platform.toLowerCase().includes(q) || (b.agentName?.toLowerCase().includes(q) ?? false)}
        emptyMessage={t("emptyMessage")}
        renderCard={(binding) => (
          <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{binding.platform}</Badge>
                  <span className="text-sm font-medium text-text-bright">{binding.agentName ?? binding.agentId}</span>
                  {binding.chatId && <span className="text-xs text-text-muted">({binding.chatId})</span>}
                </div>
              </div>
              <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget(binding.id);
                    setConfirmOpen(true);
                  }}
                >
                  {t("btn.delete")}
                </Button>
              </div>
            </div>
          </div>
        )}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={t("dialog.createTitle")}
        onSubmit={handleSave}
        loading={formSaving}
      >
        <div className="space-y-4">
          <div>
            <Label>{t("form.platform")}</Label>
            <Input
              value={formPlatform}
              onChange={(e) => setFormPlatform(e.target.value)}
              className="mt-1"
              placeholder="telegram"
            />
          </div>
          <div>
            <Label>{t("form.chatId")}</Label>
            <Input value={formChatId} onChange={(e) => setFormChatId(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>{t("form.agent")}</Label>
            <Select value={formAgentId} onValueChange={setFormAgentId}>
              <SelectTrigger className="mt-1">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {environments.map((env) => (
                  <SelectItem key={env.id} value={env.id}>
                    {env.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription")}
        variant="destructive"
        onConfirm={() => runDelete(deleteTarget!)}
      />
    </div>
  );
}
