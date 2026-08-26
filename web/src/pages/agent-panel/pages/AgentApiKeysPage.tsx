import { useRequest } from "ahooks";
import { AlertTriangle, Copy, KeyRound, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { type ApiKeyInfo, apiKeyApi } from "@/src/api/api-keys";
import { unwrap } from "@/src/api/request";
import { AgentPageHeader } from "../shared/AgentPageHeader";
import { filterApiKeys, formatApiKeyDate, getApiKeyCreateErrorMessage } from "./agent-api-keys-utils";
import "./agent-api-keys.css";

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
  const { t, i18n } = useTranslation("apikey");
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
      <header>
        <span />
        <span>{t("column.name")}</span>
        <span>{t("column.prefix")}</span>
        <span>{t("column.created")}</span>
        <span>{t("column.lastUsed")}</span>
        <span>{t("column.expires")}</span>
        <span />
      </header>
      {keys.map((key) => (
        <article key={key.id}>
          <span className="api-key-row-icon">
            <KeyRound className="size-4" />
          </span>
          <strong>{key.name}</strong>
          <code>{key.prefix}••••••••</code>
          <time>{formatApiKeyDate(key.createdAt, i18n.language, t("date.never"))}</time>
          <time>{formatApiKeyDate(key.lastUsedAt, i18n.language, t("date.neverUsed"))}</time>
          <time>{formatApiKeyDate(key.expiresAt, i18n.language, t("date.neverExpires"))}</time>
          <Button variant="ghost" size="icon-sm" onClick={() => onRevoke(key.id)} aria-label={t("btn.revoke")}>
            <Trash2 className="size-4" />
          </Button>
        </article>
      ))}
      {keys.length === 0 ? (
        <div className="api-key-empty">
          <KeyRound className="size-6" />
          <span>{t("emptyMessage")}</span>
        </div>
      ) : null}
    </section>
  );
}

export function AgentApiKeysPage() {
  const { t } = useTranslation("apikey");
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
  const copyKey = async () => {
    if (!newKeyValue) return;
    if (window.isSecureContext && typeof navigator.clipboard?.writeText === "function") {
      try {
        await navigator.clipboard.writeText(newKeyValue);
        toast.success(t("toast.copied"));
        return;
      } catch {
        // Continue to the in-dialog selection fallback below.
      }
    }
    if (copyElementText(keyCodeRef.current)) toast.success(t("toast.copied"));
    else toast.error(t("toast.copyFailed"));
  };

  return (
    <div className="agent-api-keys-page">
      <AgentPageHeader
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
        <div className="api-key-error">
          <AlertTriangle className="size-5" />
          <span>{t("toast.loadFailed")}</span>
          <Button variant="ghost" size="sm" onClick={refresh}>
            <RefreshCw className="size-4" />
            {t("btn.retry")}
          </Button>
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
    </div>
  );
}
