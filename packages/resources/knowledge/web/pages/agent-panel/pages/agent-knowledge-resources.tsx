import { FileTypeIcon } from "@fenix/ui-components/components/file-icon-helper";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { Button } from "@fenix/ui-components/ui/button";
import { Switch } from "@fenix/ui-components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@fenix/ui-components/ui/table";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { ExternalLink, File, RefreshCw, Trash2, Upload } from "lucide-react";
import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { KnowledgeResourceInfo } from "../../../types/knowledge";
import { KB_STATUS_TONES, kbStatusLabel } from "./knowledge-status";

interface AgentKnowledgeResourcesProps {
  resources: KnowledgeResourceInfo[];
  canManage: boolean;
  uploading: boolean;
  deletingResourceId: string | null;
  reparsingResourceId: string | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFilesSelected: (files: File[]) => void;
  onOpenChunks: (resource: KnowledgeResourceInfo) => void;
  onToggleEnabled: (resource: KnowledgeResourceInfo, enabled: boolean) => void;
  onReparse: (resource: KnowledgeResourceInfo) => void;
  onPreview: (resource: KnowledgeResourceInfo) => void;
  onDelete: (resource: KnowledgeResourceInfo) => void;
}

/**
 * 表头 / 表体单元格的公用类串（2026-09-28 自页面样式表 `AgentKnowledgeBasesPage.css`（原 `agent-knowledge.css`）
 * 的 `.knowledge-resources [data-slot="table-head"|"table-cell"]` 两条属性选择器搬回）。
 *
 * 表头四值：`h-10`（40px，`TableHead` 自带、逐值相同）· `px-3.5`（14px，顶掉自带的 `px-2`）·
 * `bg-slate-50`（原 `#f7f9fc`）· `text-xs`（原 `font-size: 11px`，按标准档取最近一档 12px）·
 * `text-slate-400`（原 `#8190a6`，顶掉自带的 `text-foreground`）。
 * 表体三值：`h-15.5`（62px）· `px-3.5`（14px）· `text-xs`（原 12px）。
 * 两条都是 `cn()`（tailwind-merge）合并：同类工具类写在后即生效，`p-2`（自带的块轴内边距）不与
 * `px-3.5` 同类、继续保留（产物里 `px-*` 排在 `p-*` 之后，横向仍按 14px 渲染）。
 * 逐单元格的长度差（`text-center` / `text-right` / `text-slate-400`）由调用点拼在常量之后。
 */
const TABLE_HEAD_CLASS = "px-3.5 bg-slate-50 text-xs text-slate-400";
const TABLE_CELL_CLASS = "h-15.5 px-3.5 text-xs";

/**
 * 文件名行（`<button>` / `<strong>` 共用）：原 `.knowledge-resource-name button, .knowledge-resource-name strong`
 * 一条后代规则。`max-w-70` = 280px，`truncate` 是 `overflow` / `text-overflow` / `white-space` 三条的合体，
 * `text-13` = 13px（本仓自有档），`text-slate-800` 对应原 `#17233a`。
 * 按钮独占的 hover 色（原 `#2563c7`）由按钮调用点追加。
 */
const RESOURCE_NAME_CLASS = "max-w-70 truncate text-13 font-semibold text-slate-800";

function formatTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleString();
}

export function AgentKnowledgeResources(props: AgentKnowledgeResourcesProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  return (
    <section className="knowledge-resources overflow-hidden bg-white border border-slate-200 rounded-lg">
      {/* 表头行的内边距 14px 16px = `py-3.5` / `px-4`，文件名行的 220px / 10px = `min-w-55` / `gap-2.5`，
          图标盒 32×32 / 圆角 8px = `size-8` / `rounded`，进度条的 5px / 78px = `h-1.25` / `max-w-19.5`，
          动作区 4px = `gap-1`：刻度已在 `@theme` 按 px 落地，工具类即设计值，不再写回 `AgentKnowledgeBasesPage.css`。
          2026-09-28 同批撤回的还有本区块的其余取值：容器描边 / 圆角（`border border-slate-200 rounded-lg`
          = 原 `1px #e3e9f1` + 10px）、表头下分隔线（`border-b border-slate-200` = 原 `1px #e8edf4`）、
          标题字号 / 字重（`text-sm font-semibold` = 原 14px / 650）、表格最小宽度（`min-w-215` = 860px）
          与两张单元格类串（见文件上方常量）。表头 / 表体那两条属性选择器（`.knowledge-resources
          [data-slot="table-head"|"table-cell"]`）随之删除——值现在挂在 `<TableHead>` / `<TableCell>`
          自己的 `className` 上，选择器不再进产物。 */}
      <header className="knowledge-resources__header flex items-center justify-between px-4 py-3.5 border-b border-slate-200">
        <h3 className="text-sm font-semibold">{t("resources.title", { count: props.resources.length })}</h3>
        <input
          ref={props.fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            const files = event.target.files ? Array.from(event.target.files) : [];
            if (files.length) props.onFilesSelected(files);
          }}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={props.uploading || !props.canManage}
          onClick={() => props.fileInputRef.current?.click()}
        >
          <Upload />
          {props.uploading ? t("btn.uploading") : t("btn.upload")}
        </Button>
      </header>
      {props.resources.length === 0 ? (
        <EmptyState className="grid min-h-56 place-content-center" icon={<File />} title={t("resources.empty")} />
      ) : (
        <Table className="min-w-215">
          <TableHeader>
            <TableRow>
              <TableHead className={TABLE_HEAD_CLASS}>{t("columns.name")}</TableHead>
              <TableHead className={`${TABLE_HEAD_CLASS} text-center`}>{t("resources.colChunks")}</TableHead>
              <TableHead className={TABLE_HEAD_CLASS}>{t("resources.colStatus")}</TableHead>
              <TableHead className={`${TABLE_HEAD_CLASS} text-center`}>{t("resources.colEnabled")}</TableHead>
              <TableHead className={TABLE_HEAD_CLASS}>{t("columns.updatedAt")}</TableHead>
              <TableHead className={`${TABLE_HEAD_CLASS} text-right`}>{t("resources.colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {props.resources.map((resource) => (
              <TableRow key={resource.id}>
                <TableCell className={TABLE_CELL_CLASS}>
                  <div className="knowledge-resource-name flex min-w-55 items-center gap-2.5">
                    {/* 图标盒的 `flex: 0 0 32px` 逐项等价于 `shrink-0 grow-0 basis-8`（`basis-8` 即 32px）。 */}
                    <span className="knowledge-resource-name__icon grid size-8 shrink-0 grow-0 basis-8 place-items-center rounded bg-surface-2">
                      <FileTypeIcon filename={resource.sourceName} />
                    </span>
                    {resource.chunkCount != null && resource.chunkCount > 0 ? (
                      <button
                        type="button"
                        className={`${RESOURCE_NAME_CLASS} hover:text-blue-600`}
                        onClick={() => props.onOpenChunks(resource)}
                        title={resource.sourceName}
                      >
                        {resource.sourceName}
                      </button>
                    ) : (
                      <strong className={RESOURCE_NAME_CLASS} title={resource.sourceName}>
                        {resource.sourceName}
                      </strong>
                    )}
                  </div>
                </TableCell>
                <TableCell className={`${TABLE_CELL_CLASS} text-center text-slate-400`}>
                  {resource.chunkCount ?? "—"}
                </TableCell>
                <TableCell className={TABLE_CELL_CLASS}>
                  {resource.runStatus === "RUNNING" && resource.parseProgress != null ? (
                    // `before:absolute`：原 `AgentKnowledgeBasesPage.css` 的
                    // `.knowledge-resource-progress::before { position: absolute }`（2026-09-28 第三波撤回；
                    // 伪元素的内容 `content: ""` 仍留在该表——内容不是「挂类」能表达的对象）。
                    <div className="knowledge-resource-progress flex min-w-27.5 items-center gap-1.75 before:absolute">
                      <span
                        className="knowledge-resource-progress__bar h-1.25 max-w-19.5 flex-1 rounded-full bg-blue-500"
                        style={{ width: `${Math.round(resource.parseProgress * 100)}%` }}
                      />
                      <small className="text-3xs text-slate-500">{Math.round(resource.parseProgress * 100)}%</small>
                    </div>
                  ) : (
                    // 状态胶囊此前是本包手写的 `.knowledge-resource-status.is-*` 色表（还带一份逐字
                    // 相同的 `statusClass` 副本），改由库的 StatusBadge 承担配色；文案随之与详情头部
                    // 同口径走字典（原先这里直接上屏后端原文 `ready`，中文界面里另一处写「就绪」）。
                    <StatusBadge
                      status={resource.status}
                      label={kbStatusLabel(t, resource.status)}
                      toneMap={KB_STATUS_TONES}
                      indicator="dot"
                    />
                  )}
                </TableCell>
                <TableCell className={`${TABLE_CELL_CLASS} text-center`}>
                  <Switch
                    checked={resource.enabled ?? true}
                    disabled={!props.canManage}
                    onCheckedChange={(checked) => props.onToggleEnabled(resource, checked)}
                  />
                </TableCell>
                <TableCell className={`${TABLE_CELL_CLASS} text-slate-400`}>
                  {formatTimestamp(resource.createdAt)}
                </TableCell>
                <TableCell className={TABLE_CELL_CLASS}>
                  <div className="knowledge-resource-actions flex items-center justify-end gap-1">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={!props.canManage || props.reparsingResourceId === resource.id}
                      onClick={() => props.onReparse(resource)}
                    >
                      <RefreshCw className={props.reparsingResourceId === resource.id ? "animate-spin" : ""} />
                      {t("reparse.btn")}
                    </Button>
                    {resource.status === "ready" && (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        title={t("preview.btn")}
                        aria-label={t("preview.btn")}
                        onClick={() => props.onPreview(resource)}
                      >
                        <ExternalLink />
                      </Button>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="text-red-500"
                      title={t("actions.delete")}
                      aria-label={t("actions.delete")}
                      disabled={!props.canManage || props.deletingResourceId === resource.id}
                      onClick={() => props.onDelete(resource)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
