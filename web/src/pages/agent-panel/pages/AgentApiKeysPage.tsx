import { useRequest } from "ahooks";
import { AlertTriangle, Copy, KeyRound, Plus, Search } from "lucide-react";
import { useRef, useState } from "react";
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
import { getApiKeyCreateErrorMessage } from "./agent-api-keys-utils";

interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
}

/**
 * 兜底复制：直接选中给定元素内的文本并执行 `execCommand('copy')`。
 *
 * 与 clipboard polyfill 不同，这里不新建 textarea、也不调用 `focus()`，因此不会触发
 * Radix 模态框的焦点陷阱（FocusScope 会在 `.focus()` 时把焦点抢回对话框，导致 polyfill
 * 的隐藏 textarea 复制到空选区）。选区落在对话框内部、复制过程同步完成，HTTP 环境下也稳定。
 *
 * @returns 是否复制成功
 */
function copyElementText(el: HTMLElement | null): boolean {
  if (!el || typeof document === "undefined") return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(el);
  selection.removeAllRanges();
  selection.addRange(range);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    selection.removeAllRanges();
  }
}

export function AgentApiKeysPage() {
  const { t } = useTranslation("apikey");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  // 指向展示新密钥的 <code>，用于 HTTP 环境下的兜底复制（见 handleCopyKey）
  const keyCodeRef = useRef<HTMLElement>(null);

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
        toast.error(getApiKeyCreateErrorMessage(err, t));
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

  /**
   * 复制新建的 API Key。
   *
   * 安全上下文（HTTPS / localhost）走原生 Clipboard API，最稳；非安全上下文（HTTP）下
   * navigator.clipboard 是 execCommand + 隐藏 textarea 的 polyfill，在本页的模态对话框里
   * 会因焦点陷阱复制失败，故直接退回“选中对话框内 <code>”的方式。全程按真实结果给出提示，
   * 不再无条件弹“已复制”。
   */
  const handleCopyKey = async () => {
    const text = newKeyValue;
    if (!text) return;

    if (window.isSecureContext && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(text);
        toast.success(t("toast.copied"));
        return;
      } catch {
        // 原生写入偶发失败（如窗口失焦），继续走下面的选区兜底
      }
    }

    if (copyElementText(keyCodeRef.current)) {
      toast.success(t("toast.copied"));
    } else {
      toast.error(t("toast.copyFailed"));
    }
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
                <code ref={keyCodeRef} className="block text-sm font-mono text-text-bright break-all pr-10 select-all">
                  {newKeyValue}
                </code>
                <button
                  type="button"
                  className="absolute right-2 top-2 rounded-md border border-border-light bg-surface-2 p-1.5 text-text-muted hover:text-text-bright hover:bg-surface-3 transition-colors"
                  onClick={handleCopyKey}
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
