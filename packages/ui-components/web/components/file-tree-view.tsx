/**
 * 文件树视图（从 apps/web 的 `agent-panel/file-tree-view.tsx` 复制并纯化）。
 *
 * 这是一个**纯展示**组件：不碰任何文件 API、不订阅事件，所有远端操作由调用方通过回调注入
 * （源实现的对应容器是宿主的 `FileTreeTab`，依赖 fs API 与 WebSocket 事件，未随包迁移）。
 * 需要 `FileTreeInputDialog` 配合的「新建/重命名/移动」弹窗同样由调用方编排。
 *
 * 纯化取舍：
 * 1. 源实现用 `envId`（宿主环境标识）作为「能否改动远端」的开关，本包改为语义化的
 *    `canMutate`；`envId` 属宿主概念，不应进入公共契约。
 * 2. 未迁移源接口里的 `isDirectory` 与 `onOpen`：在该视图内没有任何使用点（死 props）。
 * 3. i18n 从宿主的 `NS.COMPONENTS` / `NS.AGENT_PANEL` 改为包内 `UI_COMPONENTS_NS`；
 *    面板标题原先取 agent-panel 命名空间的 `tabFiles`，本包改用 `fileTree.title`。
 * 4. 右键菜单与 Arborist 拆成独立模块（`file-tree-context-menu` / `file-tree-arborist`）。
 */

import { Folder, FolderInput, FolderPlus, Loader2, RefreshCw, Search, Upload, X } from "lucide-react";
import type { ChangeEvent, DragEvent, MouseEvent, ReactNode, RefObject } from "react";
import { useTranslation } from "react-i18next";

import { ConfirmDialog } from "../config/ConfirmDialog";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { cn } from "../lib/cn";
import { FileTreeArborist } from "./file-tree-arborist";
import type { FileTreeContextMenuState, FileTreeDownloadState } from "./file-tree-context-menu";
import { FileTreeContextMenu } from "./file-tree-context-menu";
import type { ParsedFileNode } from "./file-tree-model";

/**
 * 面板标题栏按钮样式（原 `.file-tree-panel__actions button` 及其 `:hover` / `:focus-visible`
 * / `:disabled` 规则）：26px 方块，图标 14px。
 */
const PANEL_ACTION_CLASS =
  "inline-grid size-[26px] place-items-center rounded-[5px] text-text-muted hover:bg-surface-2 hover:text-text-primary focus-visible:bg-surface-2 focus-visible:text-text-primary disabled:opacity-[0.45]";

/**
 * 分区标题（工作区 / 我的文件）公共样式，两者只有文字色与右内边距不同。
 *
 * 原规则里的 `font-family: inherit` 未翻译：font-family 本就是继承属性，没有宿主覆盖时该声明是空操作。
 */
const SECTION_HEADING_CLASS =
  "flex h-8 min-w-0 shrink-0 items-center gap-1.5 ps-5 text-[12px] font-semibold normal-case tracking-normal";

export interface FileTreeViewProps {
  /** 首屏或刷新中；影响刷新按钮转圈与空态展示。 */
  loading: boolean;
  /** 上次拉取失败但仍在自动重连：显示可重试的横幅而不是空态。 */
  stale: boolean;
  uploading: boolean;
  dragOver: boolean;
  searchQuery: string;
  /** 归一化（去空白 / 小写）后的搜索词；非空时走搜索结果分支。 */
  normalizedSearch: string;
  /** 搜索词非空时是否命中结果。 */
  hasSearchResults: boolean;
  /** 数据变化时递增，用于强制 Arborist 重建。 */
  treeVersion: number;
  showTree: boolean;
  workspaceHasNodes: boolean;
  userHasNodes: boolean;
  expandedIds: string[];
  contextMenu: FileTreeContextMenuState | null;
  deleteConfirm: { path: string; name: string } | null;
  deleting: boolean;
  download: FileTreeDownloadState | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  folderInputRef: RefObject<HTMLInputElement | null>;
  workspaceNodes: ParsedFileNode[];
  userNodes: ParsedFileNode[];
  /** false 时禁用全部改动远端文件的操作（源实现以「有无 envId」表达）。 */
  canMutate?: boolean;
  onSelect: (node: ParsedFileNode) => void;
  onToggle: (nodeId: string, expanded: boolean) => void;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onUploadClick: (targetDir?: string) => void;
  onFolderUploadClick: (targetDir?: string) => void;
  onDrop: (event: DragEvent<HTMLDivElement>, targetDir?: string) => void;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFolderInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  onReference: () => void;
  onDownload: (path: string, isDir: boolean) => void;
  onRenameRequest: (path: string, name: string) => void;
  onMoveRequest: (path: string) => void;
  onDeleteRequest: (path: string, name: string) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
}

/** VS Code 风格的文件浏览器：搜索框 + 工作区/我的文件双分区 + 右键菜单。 */
export function FileTreeView(props: FileTreeViewProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const canMutate = props.canMutate ?? true;

  const createAtSelected = (kind: "file" | "folder") => {
    const parent = "user";
    kind === "file" ? props.onNewFile(parent) : props.onNewFolder(parent);
  };

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden text-text-secondary">
      <div className="flex min-h-[38px] shrink-0 items-center justify-between ps-2.5 pe-1.5 text-[12px] text-text-primary [font-weight:650]">
        <span>{t("fileTree.title")}</span>
        <div data-slot="file-tree-panel-actions" className="flex items-center gap-px [&_svg]:size-[14px]">
          <button
            type="button"
            className={PANEL_ACTION_CLASS}
            onClick={props.onRefresh}
            disabled={props.loading || !canMutate}
            title={t("fileTree.refresh")}
            aria-label={t("fileTree.refresh")}
          >
            <RefreshCw className={props.loading ? "animate-spin" : undefined} aria-hidden />
          </button>
          <button
            type="button"
            className={PANEL_ACTION_CLASS}
            onClick={() => createAtSelected("folder")}
            disabled={!canMutate}
            title={t("fileTree.contextMenu.newFolder")}
          >
            <FolderPlus aria-hidden />
          </button>
          <button
            type="button"
            className={PANEL_ACTION_CLASS}
            onClick={() => props.onUploadClick()}
            disabled={props.uploading || !canMutate}
            title={t("fileTree.upload")}
          >
            <Upload aria-hidden />
          </button>
          <button
            type="button"
            className={PANEL_ACTION_CLASS}
            onClick={() => props.onFolderUploadClick()}
            disabled={props.uploading || !canMutate}
            title={t("fileTree.uploadFolder")}
          >
            <FolderInput aria-hidden />
          </button>
          <input ref={props.fileInputRef} type="file" multiple hidden onChange={props.onFileInputChange} />
          <input
            ref={props.folderInputRef}
            type="file"
            multiple
            hidden
            onChange={props.onFolderInputChange}
            // @ts-expect-error webkitdirectory is supported by current desktop browsers.
            webkitdirectory=""
            directory=""
          />
        </div>
      </div>

      <label className="mx-2 mb-2 flex h-[30px] shrink-0 items-center gap-1.5 rounded-[6px] bg-surface-2 px-2 text-text-muted focus-within:shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--color-brand)_32%,transparent)] [&>button>svg]:size-[13px] [&>svg]:size-[13px]">
        <Search aria-hidden />
        <input
          type="search"
          className="w-full min-w-0 border-0 bg-transparent text-[12px] text-text-primary outline-none"
          value={props.searchQuery}
          onChange={(event) => props.onSearchChange(event.target.value)}
          placeholder={t("fileTree.searchPlaceholder")}
          aria-label={t("fileTree.searchPlaceholder")}
        />
        {props.searchQuery && (
          <button type="button" onClick={() => props.onSearchChange("")} aria-label={t("fileTree.clearSearch")}>
            <X aria-hidden />
          </button>
        )}
      </label>

      <div
        data-slot="file-tree-sections"
        className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
        onDragOver={props.onDragOver}
        onDragEnter={props.onDragEnter}
        onDragLeave={props.onDragLeave}
        onDrop={(event) => {
          const node = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id][data-is-dir='true']");
          const target =
            node?.dataset.nodeId ??
            (event.target as HTMLElement).closest<HTMLElement>("[data-upload-target]")?.dataset.uploadTarget;
          props.onDrop(event, target);
        }}
        onContextMenu={props.onContextMenu}
      >
        {props.dragOver && (
          <div className="pointer-events-none absolute inset-0 z-[3] grid place-items-center rounded-[var(--radius)] border border-dashed border-border-active bg-brand/10 text-[12px] text-brand">
            {t("fileTree.dropToUpload")}
          </div>
        )}
        {props.stale ? (
          <Feedback
            icon={<Loader2 className="animate-spin" />}
            text={t("fileTree.staleBanner")}
            action={
              <button
                type="button"
                data-slot="file-tree-feedback-action"
                className="min-h-7 rounded-[6px] border border-border-subtle bg-surface-1 px-2.5 text-[11px] text-text-secondary hover:border-[color-mix(in_srgb,var(--color-brand)_35%,var(--color-border-subtle))] hover:text-brand focus-visible:border-[color-mix(in_srgb,var(--color-brand)_35%,var(--color-border-subtle))] focus-visible:text-brand"
                onClick={props.onRefresh}
              >
                {t("fileTree.retry")}
              </button>
            }
          />
        ) : props.loading ? (
          <Feedback icon={<Loader2 className="animate-spin" />} text={t("tree.loading")} />
        ) : props.normalizedSearch ? (
          props.hasSearchResults ? (
            <FileTreeSections {...props} />
          ) : (
            <Feedback icon={<Search />} text={t("fileTree.noSearchResults")} />
          )
        ) : (
          <FileTreeSections {...props} />
        )}
      </div>

      {props.contextMenu && (
        <FileTreeContextMenu
          state={props.contextMenu}
          download={props.download}
          onReference={props.onReference}
          onDownload={props.onDownload}
          onRenameRequest={props.onRenameRequest}
          onMoveRequest={props.onMoveRequest}
          onDeleteRequest={props.onDeleteRequest}
          onNewFile={props.onNewFile}
          onNewFolder={props.onNewFolder}
        />
      )}
      <ConfirmDialog
        open={!!props.deleteConfirm}
        onOpenChange={(open) => !open && props.onCloseDelete()}
        title={t("fileTree.contextMenu.delete")}
        description={props.deleteConfirm?.name ?? ""}
        variant="destructive"
        onConfirm={props.onConfirmDelete}
        confirmLabel={t("fileTree.contextMenu.delete")}
        loading={props.deleting}
      />
    </div>
  );
}

function FileTreeSections(props: FileTreeViewProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  return (
    <div
      data-slot="file-tree-sections-layout"
      className="grid min-h-0 flex-1 grid-rows-[minmax(112px,3fr)_minmax(68px,2fr)] overflow-hidden"
    >
      <section data-upload-target="" className="flex h-full min-h-0 flex-col">
        <div className={cn(SECTION_HEADING_CLASS, "text-text-secondary")}>{t("fileTree.workspace")}</div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {props.showTree && props.workspaceHasNodes ? (
            <FileTreeArborist
              key={`workspace:${props.treeVersion}:${props.normalizedSearch}`}
              data={props.workspaceNodes}
              expandedIds={props.expandedIds}
              onSelect={props.onSelect}
              onToggle={props.onToggle}
              onRefresh={props.onRefresh}
              onNewFile={props.onNewFile}
              onDeleteRequest={props.onDeleteRequest}
            />
          ) : (
            <Feedback icon={<Folder />} text={t("fileTree.emptyState")} detail={t("fileTree.emptyHint")} />
          )}
        </div>
      </section>
      <section data-upload-target="user" className="flex h-full min-h-0 flex-col border-t border-border-subtle">
        <div className={cn(SECTION_HEADING_CLASS, "pe-2.5 text-text-primary")}>
          <span>{t("fileTree.user")}</span>
          <button
            type="button"
            data-slot="file-tree-section-upload"
            className="ml-auto inline-grid size-[26px] shrink-0 place-items-center rounded-[5px] text-brand hover:bg-transparent focus-visible:bg-transparent focus-visible:[outline:2px_solid_var(--color-surface-3)] focus-visible:outline-offset-[-2px] disabled:opacity-[0.45] [&_svg]:size-4"
            title={t("fileTree.upload")}
            aria-label={t("fileTree.upload")}
            onClick={() => props.onUploadClick("user")}
            disabled={props.uploading || !(props.canMutate ?? true)}
          >
            <Upload aria-hidden />
          </button>
        </div>
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          {props.showTree && props.userHasNodes ? (
            <FileTreeArborist
              key={`user:${props.treeVersion}:${props.normalizedSearch}`}
              data={props.userNodes}
              expandedIds={props.expandedIds}
              onSelect={props.onSelect}
              onToggle={props.onToggle}
              onRefresh={props.onRefresh}
              onNewFile={props.onNewFile}
              onDeleteRequest={props.onDeleteRequest}
            />
          ) : (
            <Feedback
              icon={<Folder />}
              text={t("fileTree.userEmptyState")}
              // 「我的文件」分区高度只有工作区的一半：复用同一反馈组件但压缩间距，并隐去图标与第二行说明。
              className="min-h-11 p-2 [&>svg]:hidden [&_p+p]:hidden"
            />
          )}
        </div>
      </section>
    </div>
  );
}

function Feedback({
  icon,
  text,
  detail,
  action,
  className,
}: {
  icon: ReactNode;
  text: string;
  detail?: string;
  action?: ReactNode;
  /** 分区级外观覆盖（由调用方传入），用于压缩「我的文件」分区的空态。 */
  className?: string;
}) {
  return (
    <div
      data-slot="file-tree-feedback"
      className={cn(
        "flex h-full flex-col items-center justify-center gap-2 p-5 text-center text-[12px] text-text-muted [&>svg]:size-6 [&>svg]:opacity-[0.65]",
        className,
      )}
      role="status"
    >
      {icon}
      <p>{text}</p>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
