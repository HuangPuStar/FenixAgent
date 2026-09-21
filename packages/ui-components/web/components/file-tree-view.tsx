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
import { FileTreeArborist } from "./file-tree-arborist";
import type { FileTreeContextMenuState, FileTreeDownloadState } from "./file-tree-context-menu";
import { FileTreeContextMenu } from "./file-tree-context-menu";
import type { ParsedFileNode } from "./file-tree-model";
import "./file-tree.css";

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
    <div className="file-tree-panel flex-1 flex flex-col overflow-hidden h-full">
      <div className="file-tree-panel__header">
        <span>{t("fileTree.title")}</span>
        <div className="file-tree-panel__actions">
          <button
            type="button"
            onClick={props.onRefresh}
            disabled={props.loading || !canMutate}
            title={t("fileTree.refresh")}
            aria-label={t("fileTree.refresh")}
          >
            <RefreshCw className={props.loading ? "animate-spin" : undefined} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => createAtSelected("folder")}
            disabled={!canMutate}
            title={t("fileTree.contextMenu.newFolder")}
          >
            <FolderPlus aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => props.onUploadClick()}
            disabled={props.uploading || !canMutate}
            title={t("fileTree.upload")}
          >
            <Upload aria-hidden />
          </button>
          <button
            type="button"
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

      <label className="file-tree-search">
        <Search aria-hidden />
        <input
          type="search"
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
        className="file-tree-sections"
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
        {props.dragOver && <div className="file-tree-drop-overlay">{t("fileTree.dropToUpload")}</div>}
        {props.stale ? (
          <Feedback
            icon={<Loader2 className="animate-spin" />}
            text={t("fileTree.staleBanner")}
            action={
              <button type="button" className="file-tree-feedback-action" onClick={props.onRefresh}>
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
    <div className="file-tree-sections-layout">
      <section data-upload-target="" className="file-tree-section file-tree-section--workspace">
        <div className="file-tree-workspace-label">{t("fileTree.workspace")}</div>
        <div className="file-tree-section-scroll">
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
      <section data-upload-target="user" className="file-tree-section file-tree-section--user">
        <div className="file-tree-user-heading">
          <span>{t("fileTree.user")}</span>
          <button
            type="button"
            className="file-tree-section-upload"
            title={t("fileTree.upload")}
            aria-label={t("fileTree.upload")}
            onClick={() => props.onUploadClick("user")}
            disabled={props.uploading || !(props.canMutate ?? true)}
          >
            <Upload aria-hidden />
          </button>
        </div>
        <div className="file-tree-section-scroll">
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
            <Feedback icon={<Folder />} text={t("fileTree.userEmptyState")} />
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
}: {
  icon: ReactNode;
  text: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="file-tree-feedback" role="status">
      {icon}
      <p>{text}</p>
      {detail && <p>{detail}</p>}
      {action}
    </div>
  );
}
