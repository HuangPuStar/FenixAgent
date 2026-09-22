import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { copyTextToClipboard } from "@fenix/ui-components/lib/clipboard";
import { formatDate } from "@fenix/ui-components/lib/format";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { AlertTriangle, Copy, KeyRound, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ApiKeyInfo, apiKeyApi } from "../../../api/api-keys";
import { filterApiKeys, getApiKeyCreateErrorMessage } from "./agent-api-keys-utils";
import "./agent-api-keys.css";
import { NS } from "@fenix/web-runtime/i18n/namespace";

/** Copy selected dialog text without moving focus outside Radix FocusScope. */
function copyElementText(element: HTMLElement | null): boolean {
  if (!element || typeof document === "undefined") return false;
  const selection = window.getSelection();
  if (!selection) return false;
  const range = document.createRange();
  range.selectNodeContents(element);
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

function ApiKeyTable({
  keys,
  loading,
  onRevoke,
}: {
  keys: ApiKeyInfo[];
  loading: boolean;
  onRevoke: (id: string) => void;
}) {
  const { t, i18n } = useTranslation(NS.APIKEY);
  if (loading) {
    return (
      <div className="api-key-table-loading">
        {[1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  return (
    <section className="api-key-table" aria-label={t("title")}>
      {keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound />}
          title={t("emptyMessage")}
          className="flex min-h-64 flex-col items-center justify-center"
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="api-key-icon-column" aria-label={t("title")} />
              <TableHead>{t("column.name")}</TableHead>
              <TableHead>{t("column.prefix")}</TableHead>
              <TableHead>{t("column.created")}</TableHead>
              <TableHead>{t("column.lastUsed")}</TableHead>
              <TableHead>{t("column.expires")}</TableHead>
              <TableHead className="api-key-action-column" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell className="api-key-icon-column">
                  <span className="api-key-row-icon">
                    <KeyRound className="size-4" />
                  </span>
                </TableCell>
                <TableCell className="api-key-name-cell">
                  <strong>{key.name}</strong>
                </TableCell>
                <TableCell>
                  <code>{key.prefix.slice(0, 10)}••••••••</code>
                </TableCell>
                <TableCell>
                  <time>{formatDate(key.createdAt, { locale: i18n.language, fallback: t("date.never") })}</time>
                </TableCell>
                <TableCell>
                  <time>{formatDate(key.lastUsedAt, { locale: i18n.language, fallback: t("date.neverUsed") })}</time>
                </TableCell>
                <TableCell>
                  <time>{formatDate(key.expiresAt, { locale: i18n.language, fallback: t("date.neverExpires") })}</time>
                </TableCell>
                <TableCell className="api-key-action-column">
                  <Button variant="ghost" size="icon-sm" onClick={() => onRevoke(key.id)} aria-label={t("btn.revoke")}>
                    <Trash2 className="size-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

export function AgentApiKeysPage() {
  const { t } = useTranslation(NS.APIKEY);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const keyCodeRef = useRef<HTMLElement>(null);

  const {
    data: keys = [],
    loading,
    error,
    refresh,
  } = useRequest(() => unwrap(apiKeyApi.list()), {
    onError: (requestError) => {
      console.error("Failed to load API keys", requestError);
      toast.error(t("toast.loadFailed"));
    },
  });
  const filteredKeys = filterApiKeys(keys, searchQuery);
  const { run: runCreate, loading: creating } = useRequest((name: string) => unwrap(apiKeyApi.create({ name })), {
    manual: true,
    onSuccess: (result) => {
      setNewKeyValue(result.key);
      toast.success(t("toast.created"));
      refresh();
    },
    onError: (requestError) => {
      console.error("Failed to create API key", requestError);
      toast.error(getApiKeyCreateErrorMessage(requestError, t));
    },
  });
  const { run: runDelete, loading: deleting } = useRequest((id: string) => unwrap(apiKeyApi.del(id)), {
    manual: true,
    onSuccess: () => {
      setConfirmOpen(false);
      setDeleteTarget(null);
      refresh();
    },
    onError: (requestError) => {
      console.error("Failed to revoke API key", requestError);
      toast.error(t("toast.deleteFailed"));
    },
  });

  const openCreate = () => {
    setFormName("");
    setNewKeyValue(null);
    setDialogOpen(true);
  };
  const createKey = () => {
    const name = formName.trim();
    if (!name) return toast.error(t("validation.nameRequired"));
    runCreate(name);
  };
  /**
   * 复制新建的 API Key。
   *
   * 安全上下文（HTTPS / localhost）走统一剪贴板原语，最稳；非安全上下文（HTTP）下
   * `navigator.clipboard` 是宿主 polyfill（隐藏 textarea + execCommand），它在**本页的模态对话框里
   * 会因焦点陷阱复制失败**，故不试、直接退回「选中框内 `<code>`」的方式——不移动焦点，也按真实结果提示。
   */
  const copyKey = async () => {
    if (!newKeyValue) return;
    if (window.isSecureContext && (await copyTextToClipboard(newKeyValue))) {
      toast.success(t("toast.copied"));
      return;
    }
    if (copyElementText(keyCodeRef.current)) toast.success(t("toast.copied"));
    else toast.error(t("toast.copyFailed"));
  };

  return (
    <AppPage className="agent-api-keys-page">
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <Button onClick={openCreate}>
            <Plus className="size-4" />
            {t("btn.create")}
          </Button>
        }
      />
      <section className="api-key-security-note">
        <ShieldCheck className="size-5" />
        <div>
          <strong>{t("security.title")}</strong>
          <p>{t("security.description")}</p>
        </div>
      </section>
      <div className="api-key-toolbar">
        <label className="api-key-search">
          <Search className="size-4" />
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
          />
        </label>
        <div className="api-key-summary">
          <strong>{filteredKeys.length}</strong>
          <span>{t("summary")}</span>
        </div>
      </div>
      {error ? (
        // 卡片外壳由调用方给（EmptyState 只负责块内排版）：与上方的表格、下方的空态保持同一种边框，
        // 此前这层外壳是 CSS 里 `.api-key-error` 单独抄的一份。
        <div className="rounded-lg border border-border bg-surface-0">
          <EmptyState
            tone="danger"
            role="alert"
            icon={<AlertTriangle />}
            title={t("toast.loadFailed")}
            action={{ label: t("btn.retry"), icon: <RefreshCw />, onClick: refresh }}
            className="flex min-h-64 flex-col items-center justify-center"
          />
        </div>
      ) : (
        <ApiKeyTable
          keys={filteredKeys}
          loading={loading}
          onRevoke={(id) => {
            setDeleteTarget(id);
            setConfirmOpen(true);
          }}
        />
      )}

      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setNewKeyValue(null);
        }}
        title={newKeyValue ? t("dialog.keyCreated") : t("dialog.createTitle")}
        onSubmit={createKey}
        loading={creating}
        hideSubmit={!!newKeyValue}
        cancelLabel={newKeyValue ? t("dialog.close") : undefined}
      >
        {newKeyValue ? (
          <div className="api-key-reveal">
            <div className="api-key-reveal-heading">
              <ShieldCheck className="size-5" />
              <div>
                <strong>{t("dialog.keyCreated")}</strong>
                <span>{t("dialog.keyWarning")}</span>
              </div>
            </div>
            <div className="api-key-value">
              <code ref={keyCodeRef}>{newKeyValue}</code>
              <Button type="button" variant="ghost" size="icon-sm" onClick={copyKey} aria-label={t("btn.copy")}>
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        ) : (
          <div className="api-key-create-field">
            <Label htmlFor="api-key-name">{t("form.name")}</Label>
            <Input id="api-key-name" value={formName} onChange={(event) => setFormName(event.target.value)} autoFocus />
          </div>
        )}
      </FormDialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.revokeTitle")}
        description={t("confirm.revokeDescription")}
        variant="destructive"
        loading={deleting}
        onConfirm={() => deleteTarget && runDelete(deleteTarget)}
      />
    </AppPage>
  );
}
