import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type Column, DataTable } from "@/components/config/DataTable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { channelApi, envApi } from "@/src/api/sdk";

type ChannelBinding = {
  id: string;
  platform: string;
  chatId: string | null;
  agentId: string;
  enabled: boolean;
  agentName?: string | null;
};

type HermesStatus = {
  connected: boolean;
  url: string;
  platforms: string[];
  reconnecting: boolean;
  lastConnectedAt: number | null;
};

type EnvironmentSummary = {
  id: string;
  name: string;
};

export function ChannelsPage() {
  const { t } = useTranslation("channels");
  const [hermesStatus, setHermesStatus] = useState<HermesStatus | null>(null);
  const [bindings, setBindings] = useState<ChannelBinding[]>([]);
  const [environments, setEnvironments] = useState<EnvironmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [formPlatform, setFormPlatform] = useState("");
  const [formChatId, setFormChatId] = useState("");
  const [formAgentId, setFormAgentId] = useState("");
  const [formSaving, setFormSaving] = useState(false);

  const loadHermesStatus = useCallback(async () => {
    const { data, error } = await channelApi.hermesStatus();
    if (error) {
      setHermesStatus(null);
      return;
    }
    setHermesStatus(data as HermesStatus);
  }, []);

  const loadBindings = useCallback(async () => {
    const { data, error } = await channelApi.listBindings();
    if (error) {
      console.error(t("loadBindingsFailed"), error);
      toast.error(t("loadBindingsFailed"));
      return;
    }
    setBindings(Array.isArray(data) ? (data as ChannelBinding[]) : []);
  }, [t]);

  const loadEnvironments = useCallback(async () => {
    const { data, error } = await envApi.list();
    if (error) {
      return;
    }
    setEnvironments(
      (Array.isArray(data) ? data : []).map((e: { id: string; name: string }) => ({
        id: e.id,
        name: e.name,
      })),
    );
  }, []);

  useEffect(() => {
    const loadAll = async () => {
      setLoading(true);
      await Promise.all([loadHermesStatus(), loadBindings(), loadEnvironments()]);
      setLoading(false);
    };
    void loadAll();
  }, [loadHermesStatus, loadBindings, loadEnvironments]);

  // Poll Hermes status every 5s
  useEffect(() => {
    const interval = setInterval(() => {
      void loadHermesStatus();
    }, 5000);
    return () => clearInterval(interval);
  }, [loadHermesStatus]);

  const handleToggleBinding = async (binding: ChannelBinding) => {
    const { data, error } = await channelApi.updateBinding({ id: binding.id }, { enabled: !binding.enabled });
    if (error) {
      console.error(t("updateBindingFailed"), error);
      toast.error(t("updateBindingFailed"));
      return;
    }
    if (data) setBindings((prev) => prev.map((b) => (b.id === binding.id ? (data as ChannelBinding) : b)));
  };

  const handleDeleteBinding = async (id: string) => {
    const { error } = await channelApi.deleteBinding({ id });
    if (error) {
      console.error(t("deleteBindingFailed"), error);
      toast.error(t("deleteBindingFailed"));
      return;
    }
    setBindings((prev) => prev.filter((b) => b.id !== id));
    toast.success(t("bindingDeleted"));
  };

  const handleCreateBinding = async () => {
    if (!formPlatform || !formAgentId) {
      toast.error(t("selectPlatformAndAgent"));
      return;
    }
    setFormSaving(true);
    const { data, error } = await channelApi.createBinding({
      platform: formPlatform,
      chatId: formChatId || "",
      agentId: formAgentId,
    });
    if (error) {
      console.error(t("createBindingFailed"), error);
      toast.error(`${t("createBindingFailed")}: ${error.message}`);
      setFormSaving(false);
      return;
    }
    setBindings((prev) => [...prev, data as ChannelBinding]);
    setDialogOpen(false);
    setFormPlatform("");
    setFormChatId("");
    setFormAgentId("");
    toast.success(t("bindingCreated"));
    setFormSaving(false);
  };

  const columns: Column<ChannelBinding>[] = [
    {
      key: "platform",
      header: t("columns.platform"),
      sortable: true,
    },
    {
      key: "chatId",
      header: t("columns.chatId"),
      render: (row) => row.chatId ?? t("columns.all"),
    },
    {
      key: "agentName",
      header: t("columns.agent"),
      render: (row) => row.agentName ?? row.agentId,
    },
    {
      key: "enabled",
      header: t("columns.enabled"),
      render: (row) => <Switch size="sm" checked={row.enabled} onCheckedChange={() => handleToggleBinding(row)} />,
    },
  ];

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-9 w-24" />
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          <Skeleton className="h-12 w-full rounded-none border-t" />
          <Skeleton className="h-12 w-full rounded-none border-t" />
        </div>
      </div>
    );
  }

  const statusColor = hermesStatus?.connected
    ? "bg-green-500"
    : hermesStatus?.reconnecting
      ? "bg-yellow-500"
      : "bg-gray-400";

  const statusText = hermesStatus?.connected
    ? t("hermes.connected")
    : hermesStatus?.reconnecting
      ? t("hermes.reconnecting")
      : t("hermes.notConfigured");

  const maskedUrl = hermesStatus?.url ? hermesStatus.url.replace(/\/\/.*@/, "//***@") : "";

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-text-bright">{t("title")}</h2>
        <Button onClick={() => setDialogOpen(true)}>{t("newBinding")}</Button>
      </div>

      {/* Hermes Connection Status Card */}
      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center gap-3">
          <div className={`h-2.5 w-2.5 rounded-full ${statusColor}`} />
          <span className="text-sm font-medium text-text-bright">{t("hermes.title")}</span>
          <Badge variant={hermesStatus?.connected ? "default" : "secondary"}>{statusText}</Badge>
        </div>
        {hermesStatus && (
          <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
            {hermesStatus.url && (
              <span>
                {t("hermes.address")}: {maskedUrl}
              </span>
            )}
            {hermesStatus.platforms.length > 0 && (
              <span>
                {t("hermes.platforms")}: {hermesStatus.platforms.join(", ")}
              </span>
            )}
            {hermesStatus.lastConnectedAt && (
              <span>
                {t("hermes.lastConnected")}: {new Date(hermesStatus.lastConnectedAt).toLocaleString()}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Bindings Table */}
      <section>
        <DataTable<ChannelBinding>
          columns={columns}
          data={bindings}
          searchable
          searchPlaceholder={t("table.searchPlaceholder")}
          emptyMessage={t("table.emptyMessage")}
          actions={(row) => (
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={() => handleDeleteBinding(row.id)}>
                {t("actions.delete")}
              </Button>
            </div>
          )}
        />
      </section>

      {/* Create Binding Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("dialog.title")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label>{t("dialog.platform")}</Label>
              <Select value={formPlatform} onValueChange={setFormPlatform}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("dialog.platformPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {hermesStatus?.platforms.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                  {!hermesStatus?.platforms.length && <SelectItem value="feishu">feishu</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>{t("dialog.chatId")}</Label>
              <Input
                value={formChatId}
                onChange={(e) => setFormChatId(e.target.value)}
                placeholder={t("dialog.chatIdPlaceholder")}
              />
            </div>
            <div className="grid gap-2">
              <Label>{t("dialog.agent")}</Label>
              <Select value={formAgentId} onValueChange={setFormAgentId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("dialog.agentPlaceholder")} />
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
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)} disabled={formSaving}>
              {t("dialog.cancel")}
            </Button>
            <Button onClick={handleCreateBinding} disabled={formSaving}>
              {formSaving ? t("dialog.creating") : t("dialog.create")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
