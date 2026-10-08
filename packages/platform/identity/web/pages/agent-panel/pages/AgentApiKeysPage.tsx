import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EMPTY_STATE_FILL_CLASS, EmptyState } from "@fenix/ui-components/config/EmptyState";
import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { AppHeader } from "@fenix/ui-components/layout/app-header";
import { AppPage } from "@fenix/ui-components/layout/app-page";
import { formatDate } from "@fenix/ui-components/lib/format";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { AlertTriangle, KeyRound, Plus, RefreshCw, Search, ShieldCheck, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type ApiKeyInfo, apiKeyApi } from "../../../api/api-keys";
import { copyApiKeyValue, filterApiKeys, getApiKeyCreateErrorMessage } from "./agent-api-keys-utils";
import "./AgentApiKeysPage.css";
import { NS } from "@fenix/web-runtime/i18n/namespace";

/**
 * 表头 / 单元格取值（2026-09-28 三轮收口）：原 `.api-key-table [data-slot="table-head"|"table-cell"]` 的几何与
 * 配色撤回渲染点——高度 42 / 66px → `h-10.5` / `h-16.5`、内距 `0 12px` → `py-0 px-3`、表头底色 `#f8fafc` →
 * `bg-slate-50`(ΔE 0.15) 与文字 `#7f8da3` → `text-slate-400`(6.48)、单元格文字 `#738096` →
 * `text-slate-500`(5.33)、字号 12px → `text-xs`、表头 11px → `text-11`。`Table` 组件用 `cn()`
 * （tailwind-merge）合并消费方 `className`：消费方是 `cn()` 末位参数，同族工具类由它顶掉，不必再靠未分层
 * 声明压 `@layer utilities`（表头的 `font-weight: 650` 无字重档，仍留在伴随表里）。
 */
const TABLE_HEAD_CLASS = "h-10.5 py-0 px-3 bg-slate-50 text-11 text-slate-400";
const TABLE_CELL_CLASS = "h-16.5 py-0 px-3 text-xs text-slate-500";

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
    // 骨架网格与卡片外壳：`grid gap-px p-2.5` + 撤回的描边 / 圆角 / 白底（`border-slate-200` 原 `#e2e8f1` ΔE 0.41）。
    return (
      <div className="api-key-table-loading grid gap-px rounded-10 border border-slate-200 bg-white p-2.5">
        {[1, 2, 3].map((item) => (
          <Skeleton key={item} className="h-16 w-full" />
        ))}
      </div>
    );
  }
  return (
    <section
      className="api-key-table overflow-hidden rounded-10 border border-slate-200 bg-white"
      aria-label={t("title")}
    >
      {keys.length === 0 ? (
        <EmptyState icon={<KeyRound />} title={t("emptyMessage")} className={EMPTY_STATE_FILL_CLASS} />
      ) : (
        <Table className="min-w-220">
          <TableHeader>
            <TableRow>
              <TableHead className={`api-key-icon-column w-13.5 ${TABLE_HEAD_CLASS}`} aria-label={t("title")} />
              <TableHead className={TABLE_HEAD_CLASS}>{t("column.name")}</TableHead>
              <TableHead className={TABLE_HEAD_CLASS}>{t("column.prefix")}</TableHead>
              <TableHead className={TABLE_HEAD_CLASS}>{t("column.created")}</TableHead>
              <TableHead className={TABLE_HEAD_CLASS}>{t("column.lastUsed")}</TableHead>
              <TableHead className={TABLE_HEAD_CLASS}>{t("column.expires")}</TableHead>
              <TableHead className={`api-key-action-column w-13 text-right ${TABLE_HEAD_CLASS}`} />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow className="last:border-b-0 hover:bg-gray-50" key={key.id}>
                <TableCell className={`api-key-icon-column w-13.5 ${TABLE_CELL_CLASS}`}>
                  <span className="api-key-row-icon grid size-7.5 place-items-center rounded-7 bg-amber-50">
                    <KeyRound className="size-4" />
                  </span>
                </TableCell>
                <TableCell className={`api-key-name-cell min-w-40 max-w-70 ${TABLE_CELL_CLASS}`}>
                  <strong className="block truncate text-13 text-slate-700">{key.name}</strong>
                </TableCell>
                <TableCell className={TABLE_CELL_CLASS}>
                  <code className="block min-w-37.5 truncate text-11 text-slate-600">
                    {key.prefix.slice(0, 10)}••••••••
                  </code>
                </TableCell>
                <TableCell className={TABLE_CELL_CLASS}>
                  <time className="text-11 text-slate-400">
                    {formatDate(key.createdAt, { locale: i18n.language, fallback: t("date.never") })}
                  </time>
                </TableCell>
                <TableCell className={TABLE_CELL_CLASS}>
                  <time className="text-11 text-slate-400">
                    {formatDate(key.lastUsedAt, { locale: i18n.language, fallback: t("date.neverUsed") })}
                  </time>
                </TableCell>
                <TableCell className={TABLE_CELL_CLASS}>
                  <time className="text-11 text-slate-400">
                    {formatDate(key.expiresAt, { locale: i18n.language, fallback: t("date.neverExpires") })}
                  </time>
                </TableCell>
                <TableCell className={`api-key-action-column w-13 text-right ${TABLE_CELL_CLASS}`}>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-gray-400"
                    onClick={() => onRevoke(key.id)}
                    aria-label={t("btn.revoke")}
                  >
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
   * 复制入口是弹窗页脚里那颗固定不滚动的按钮（见下方 `FormDialog` 的 `submitLabel`）——密钥再长也不会
   * 把它挤出可视区。这里只负责把 `copyApiKeyValue` 的真实结果转成提示：失败不静默。
   */
  const copyKey = async () => {
    if (!newKeyValue) return;
    if (await copyApiKeyValue(newKeyValue, keyCodeRef.current)) toast.success(t("toast.copied"));
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
      {/* 刻度（间距 / 高度 / 圆角）都在 `@theme` 按 px 落地，刻度类即设计值：提示条的间距与内距、
          工具行的间隙与外边距、搜索框的间隙 / 高度 / 内距 / 圆角分别由 `className` 承担，
          `AgentApiKeysPage.css` 只留 `className` 表达不了的取值（配色、非标准档圆角、复合宽度、
          结构性选择器与窄屏媒体块）。同一属性只由一边声明。 */}
      {/* 三轮收口的落点（2026-09-28）：提示条布局 / 圆角 / 描边 / 底色（`border-amber-100` 原 `#f1dfb8`
          ΔE 5.15、`bg-orange-50` 原 `#fffaf0` ΔE 1.47），正文 `text-11`（原 11px，无标准档）；标题的
          `#6e4e18` 与正文的 `#947640` 超出归一阈值，仍留在伴随表里。 */}
      <section className="api-key-security-note flex items-start gap-3 mt-4.5 rounded-10 border border-amber-100 bg-orange-50 py-3.5 px-4">
        <ShieldCheck className="size-5" />
        <div className="min-w-0">
          <strong className="text-xs">{t("security.title")}</strong>
          <p className="m-0 mt-0.5 text-11">{t("security.description")}</p>
        </div>
      </section>
      {/* 工具行：12px 间隙与 `margin: 18px 0 14px` 回到渲染点（`gap-3` / `mt-4.5` / `mb-3.5` 即
          4px 刻度的 12 / 18 / 14px）；类名同时是 ≤680px 媒体块改轴向的钩子。
          搜索框：布局 / 描边（`border-slate-200` 原 `#dce5ef` ΔE 1.44）/ 白底 / 图标色（原 `#91a0b5`
          ΔE 1.07）与聚焦描边（`focus-within:border-blue-300` 原 `#8bb5f3` ΔE 4.82）已撤回渲染点；
          `<input>` 拿到 `text-slate-700`（原 `#253550` ΔE 4.45）与 `placeholder:text-gray-400`
          （原 `#9ba8ba` ΔE 2.86），`min-w-0` / `flex-1` / `border-0` / `outline-0` / `bg-transparent` 同理；
          摘要行 `text-11 text-slate-400`（原 `#8a97aa` ΔE 3.56）、数值 `text-15 text-sky-700`
          （原 `#2e65b7` ΔE 5.71）。 */}
      <div className="api-key-toolbar flex items-center gap-3 mt-4.5 mb-3.5">
        <label className="api-key-search flex items-center gap-2.25 h-10.5 rounded border border-slate-200 bg-white px-3.25 text-slate-400 focus-within:border-blue-300">
          <Search className="size-4" />
          <input
            className="min-w-0 flex-1 border-0 bg-transparent text-13 text-slate-700 outline-0 placeholder:text-gray-400"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t("searchPlaceholder")}
          />
        </label>
        <div className="api-key-summary flex items-baseline gap-1.25 text-11 text-slate-400">
          <strong className="text-15 text-sky-700">{filteredKeys.length}</strong>
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
            className={EMPTY_STATE_FILL_CLASS}
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
        // 密钥展示态把「复制」放在页脚提交位：页脚固定不滚动，长密钥也不会把它推到滚动区外。
        onSubmit={newKeyValue ? copyKey : createKey}
        loading={creating}
        submitLabel={newKeyValue ? t("btn.copy") : undefined}
        cancelLabel={newKeyValue ? t("dialog.close") : undefined}
      >
        {newKeyValue ? (
          <div className="api-key-reveal grid gap-3.5 py-2">
            <div className="api-key-reveal-heading flex items-start gap-2.5 text-emerald-700">
              <ShieldCheck className="size-5" />
              <div>
                <strong className="block text-13">{t("dialog.keyCreated")}</strong>
                <span className="block mt-0.75 text-11 leading-[1.5]">{t("dialog.keyWarning")}</span>
              </div>
            </div>
            <div className="api-key-value flex items-center gap-2 min-w-0 bg-slate-100 py-2.75 px-3">
              <code className="min-w-0 flex-1 wrap-anywhere text-xs text-slate-700 select-all" ref={keyCodeRef}>
                {newKeyValue}
              </code>
            </div>
          </div>
        ) : (
          <div className="api-key-create-field grid gap-1.75 py-2">
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
