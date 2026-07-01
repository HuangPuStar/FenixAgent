import { useRequest } from "ahooks";
import { AlertTriangle, Copy, KeyRound, Plus, Search } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiKeyApi } from "@/src/api/api-keys";
import { unwrap } from "@/src/api/request";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
}

export function AgentApiKeysPage() {
  const { t } = useTranslation("apikey");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  // 列表查询
  const {
    data: listData,
    loading,
    refresh,
  } = useRequest(() => unwrap(apiKeyApi.list()), {
    onError: (err) => {
      console.error(err);
      toast.error(t("toast.loadFailed"));
    },
  });
  const keys = Array.isArray(listData) ? (listData as unknown as ApiKeyInfo[]) : [];

  // 创建 API Key
  const { run: runCreate, loading: creating } = useRequest(
    async (data: { name: string }) => unwrap(apiKeyApi.create(data)),
    {
      manual: true,
      onSuccess: (result) => {
        if (result?.key) setNewKeyValue(result.key);
        toast.success(t("toast.created"));
        refresh();
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("toast.createFailed"));
      },
    },
  );

  // 删除 API Key：静默操作，列表项消失已是最佳反馈
  const { run: runDelete } = useRequest((id: string) => unwrap(apiKeyApi.del(id)), {
    manual: true,
    onSuccess: () => {
      setConfirmOpen(false);
      setDeleteTarget(null);
      refresh();
    },
    onError: (err) => {
      console.error(err);
      toast.error(t("toast.deleteFailed"));
    },
  });

  const handleOpenCreate = () => {
    setFormName("");
    setNewKeyValue(null);
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameRequired"));
      return;
    }
    runCreate({ name: formName.trim() });
  };

  const formatDate = (ts: number | null) => {
    if (!ts) return "—";
    return new Date(ts).toLocaleDateString();
  };

  // 基于外部搜索过滤密钥列表
  const filteredKeys = searchQuery.trim()
    ? keys.filter((k) => k.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : keys;

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
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
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
        actions={
          <button
            type="button"
            onClick={handleOpenCreate}
            className="inline-flex h-10 shrink-0 items-center gap-2 rounded-lg bg-[#1677ff] px-[22px] text-[13px] font-semibold text-white shadow-[0_4px_14px_rgba(22,119,255,0.18)] transition hover:bg-[#0f67df]"
          >
            <Plus className="h-4 w-4" />
            {t("btn.create")}
          </button>
        }
      />

      {/* 搜索栏 */}
      <div className="mb-3.5 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a8bd]" />
          <input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("searchPlaceholder")}
            className="h-10 w-full rounded-lg border border-[#dce5ef] bg-white pl-10 pr-4 text-[13px] text-[#1a2944] outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
          />
        </div>
      </div>

      <AgentCardList
        items={filteredKeys}
        cardKey={(k) => k.id}
        emptyMessage={t("emptyMessage")}
        gridCols="grid-cols-1 sm:grid-cols-2 xl:grid-cols-3"
        renderCard={(key) => (
          <div className="rounded-lg border border-border-light bg-surface-1 transition-colors hover:border-border-active hover:shadow-sm overflow-hidden">
            {/* ── 头部：图标 + 名称 + 前缀 ── */}
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
              <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-amber-500 flex items-center justify-center text-base font-extrabold text-white">
                <KeyRound className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-text-bright truncate">{key.name}</span>
                  <span className="inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium font-mono bg-surface-2 text-text-muted truncate">
                    {key.prefix}...
                  </span>
                </div>
                <p className="text-[11px] text-text-muted mt-0.5">
                  {t("column.created")}: {formatDate(key.createdAt)}
                  {key.expiresAt && ` · ${t("column.expires")}: ${formatDate(key.expiresAt)}`}
                </p>
              </div>
            </div>

            {/* ── 操作栏 ── */}
            <div className="flex items-center px-4 py-2.5 border-t border-border-subtle bg-surface-0 text-[11px]">
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setDeleteTarget(key.id);
                  setConfirmOpen(true);
                }}
                className="text-red-500 hover:text-red-600 transition-colors ml-auto"
              >
                {t("btn.revoke")}
              </button>
            </div>
          </div>
        )}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setNewKeyValue(null);
        }}
        title={newKeyValue ? t("dialog.keyCreated") : t("dialog.createTitle")}
        onSubmit={handleSave}
        loading={creating}
        hideSubmit={!!newKeyValue}
        cancelLabel={newKeyValue ? t("dialog.close") : undefined}
      >
        <div className="space-y-4">
          {newKeyValue ? (
            <div className="space-y-4">
              <div className="relative rounded-lg border-2 border-amber-500/30 bg-amber-500/5 p-3">
                <code className="block text-sm font-mono text-text-bright break-all pr-10 select-all">
                  {newKeyValue}
                </code>
                <button
                  type="button"
                  className="absolute right-2 top-2 rounded-md border border-border-light bg-surface-2 p-1.5 text-text-muted hover:text-text-bright hover:bg-surface-3 transition-colors"
                  onClick={() => {
                    navigator.clipboard.writeText(newKeyValue!);
                    toast.success(t("toast.copied"));
                  }}
                  title={t("btn.copy")}
                >
                  <Copy className="h-4 w-4" />
                </button>
              </div>
              <div className="flex items-start gap-2 rounded-md border border-red-500/20 bg-red-500/5 p-3">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-500" />
                <p className="text-xs text-red-600 dark:text-red-400 leading-relaxed">{t("dialog.keyWarning")}</p>
              </div>
            </div>
          ) : (
            <div>
              <Label>{t("form.name")}</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} className="mt-1" />
            </div>
          )}
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.revokeTitle")}
        description={t("confirm.revokeDescription")}
        variant="destructive"
        onConfirm={() => deleteTarget && runDelete(deleteTarget)}
      />
    </div>
  );
}
