import {
  Download,
  ExternalLink,
  FilePlus2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  Move,
  Search,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import type { ChangeEvent, DragEvent, MouseEvent, ReactNode, RefObject } from "react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import type { NodeState, TreeNodeData, TreeProps } from "@/components/ui/tree";
import { Tree } from "@/components/ui/tree";
import { FileTypeIcon } from "@/src/components/file-icon-helper";
import { NS } from "../../i18n";

interface ContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

interface FileTreeViewProps {
  envId: string | null;
  loading: boolean;
  stale: boolean;
  uploading: boolean;
  dragOver: boolean;
  searchQuery: string;
  normalizedSearch: string;
  treeVersion: number;
  showTree: boolean;
  hasSearchResults: boolean;
  expandedIds: string[];
  contextMenu: ContextMenuState | null;
  deleteConfirm: { path: string; name: string } | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  folderInputRef: RefObject<HTMLInputElement | null>;
  getChildren: TreeProps["getChildren"];
  onSelect: NonNullable<TreeProps["onSelect"]>;
  onToggle: NonNullable<TreeProps["onToggle"]>;
  onSearchChange: (query: string) => void;
  onRefresh: () => void;
  onUploadClick: () => void;
  onFolderUploadClick: () => void;
  onFileInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onFolderInputChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onDragOver: (event: DragEvent<HTMLDivElement>) => void;
  onDragEnter: (event: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (event: DragEvent<HTMLDivElement>) => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLDivElement>) => void;
  isDirectory: (path: string) => boolean;
  onOpen: (path: string) => void;
  onReference: () => void;
  onDownload: (path: string, isDir: boolean) => void;
  onRename: (path: string, name: string) => void;
  onMove: (path: string, destination: string) => void;
  onDeleteRequest: (path: string, name: string) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
  onCloseDelete: () => void;
  onConfirmDelete: () => void;
}

/** Pure presentation for the VS Code-like explorer; remote operations stay in FileTreeTab. */
export function FileTreeView(props: FileTreeViewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const { t: tPanel } = useTranslation(NS.AGENT_PANEL);

  const renderActions = useCallback(
    (node: TreeNodeData) =>
      props.isDirectory(node.id) ? (
        <button
          type="button"
          className="file-tree-row-action"
          aria-label={t("fileTree.newFileIn", { name: node.label })}
          title={t("fileTree.newFile")}
          onClick={(event) => {
            event.stopPropagation();
            props.onNewFile(node.id);
          }}
        >
          <FilePlus2 aria-hidden />
        </button>
      ) : (
        <button
          type="button"
          className="file-tree-row-action"
          aria-label={t("fileTree.openFile", { name: node.label })}
          title={t("fileTree.open")}
          onClick={(event) => {
            event.stopPropagation();
            props.onOpen(node.id);
          }}
        >
          <ExternalLink aria-hidden />
        </button>
      ),
    [props.isDirectory, props.onNewFile, props.onOpen, t],
  );

  const renderLabel = useCallback(
    (node: TreeNodeData, state: NodeState) => {
      if (props.isDirectory(node.id)) {
        const isUserRoot = node.id === "user";
        const Icon = isUserRoot ? UserRound : state.expanded ? FolderOpen : Folder;
        return (
          <span className={isUserRoot ? "file-tree-user-root" : "file-tree-folder-label"}>
            <Icon className="h-4 w-4 flex-shrink-0" />
            <span className="truncate" title={node.label}>
              {node.label}
            </span>
            {isUserRoot && <small>{t("fileTree.currentUser")}</small>}
          </span>
        );
      }
      return (
        <span className="file-tree-file-label">
          <span className="h-4 w-4 flex-shrink-0 inline-flex items-center justify-center">
            <FileTypeIcon filename={node.label ?? ""} />
          </span>
          <span className="truncate" title={node.label}>
            {node.label}
          </span>
        </span>
      );
    },
    [props.isDirectory, t],
  );

  const createAtSelected = (kind: "file" | "folder") => {
    const parent = "user";
    kind === "file" ? props.onNewFile(parent) : props.onNewFolder(parent);
  };

  return (
    <div className="file-tree-panel flex-1 flex flex-col overflow-hidden h-full">
      <div className="file-tree-panel__header">
        <span>{tPanel("tabFiles")}</span>
        <div className="file-tree-panel__actions">
          <button
            type="button"
            onClick={() => createAtSelected("file")}
            disabled={!props.envId}
            title={t("fileTree.newFile")}
          >
            <FilePlus2 aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => createAtSelected("folder")}
            disabled={!props.envId}
            title={t("fileTree.contextMenu.newFolder")}
          >
            <FolderPlus aria-hidden />
          </button>
          <button
            type="button"
            onClick={props.onUploadClick}
            disabled={props.uploading || !props.envId}
            title={t("fileTree.upload")}
          >
            <Upload aria-hidden />
          </button>
          <button
            type="button"
            onClick={props.onFolderUploadClick}
            disabled={props.uploading || !props.envId}
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
      <div className="file-tree-workspace-label">{t("fileTree.workspace")}</div>

      {props.stale && (
        <div role="status" className="file-tree-stale">
          <Loader2 className="animate-spin" aria-hidden />
          <span>{t("fileTree.staleBanner")}</span>
          <button type="button" onClick={props.onRefresh}>
            {t("fileTree.retry")}
          </button>
        </div>
      )}

      <div
        className="flex-1 overflow-auto relative"
        onDragOver={props.onDragOver}
        onDragEnter={props.onDragEnter}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
        onContextMenu={props.onContextMenu}
      >
        {props.dragOver && <div className="file-tree-drop-overlay">{t("fileTree.dropToUpload")}</div>}
        {props.loading ? (
          <Feedback icon={<Loader2 className="animate-spin" />} text={t("tree.loading")} />
        ) : props.showTree && (!props.normalizedSearch || props.hasSearchResults) ? (
          <Tree
            key={`${props.treeVersion}:${props.normalizedSearch}`}
            getChildren={props.getChildren}
            defaultExpandedIds={props.expandedIds}
            onSelect={props.onSelect}
            onToggle={props.onToggle}
            renderActions={renderActions}
            renderLabel={renderLabel}
          />
        ) : props.normalizedSearch ? (
          <Feedback icon={<Search />} text={t("fileTree.noSearchResults")} />
        ) : (
          <Feedback icon={<Folder />} text={t("fileTree.emptyState")} detail={t("fileTree.emptyHint")} />
        )}
      </div>

      {props.contextMenu && <ContextMenu state={props.contextMenu} {...props} />}
      <ConfirmDialog
        open={!!props.deleteConfirm}
        onOpenChange={(open) => !open && props.onCloseDelete()}
        title={t("fileTree.contextMenu.delete")}
        description={props.deleteConfirm?.name ?? ""}
        variant="destructive"
        onConfirm={props.onConfirmDelete}
        confirmLabel={t("fileTree.contextMenu.delete")}
      />
    </div>
  );
}

function Feedback({ icon, text, detail }: { icon: ReactNode; text: string; detail?: string }) {
  return (
    <div className="file-tree-feedback">
      {icon}
      <p>{text}</p>
      {detail && <p>{detail}</p>}
    </div>
  );
}

function ContextMenu({ state, ...props }: { state: ContextMenuState } & FileTreeViewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const name = state.path.split("/").pop() ?? state.path;
  return (
    <div className="file-tree-context-menu" style={{ left: state.x, top: state.y }}>
      <button type="button" onClick={props.onReference}>
        {t("fileTree.contextMenu.reference")}
      </button>
      <button type="button" onClick={() => props.onDownload(state.path, state.isDir)}>
        <Download aria-hidden />
        {state.isDir ? t("fileTree.downloadZip") : t("fileTree.download")}
      </button>
      <button
        type="button"
        onClick={() => {
          const next = window.prompt(t("fileTree.contextMenu.rename"), name);
          if (next) props.onRename(state.path, next);
        }}
      >
        {t("fileTree.contextMenu.rename")}
      </button>
      <button
        type="button"
        onClick={() => {
          const next = window.prompt(t("fileTree.contextMenu.movePrompt"), state.path);
          if (next) props.onMove(state.path, next);
        }}
      >
        <Move aria-hidden />
        {t("fileTree.contextMenu.move")}
      </button>
      <button type="button" className="is-danger" onClick={() => props.onDeleteRequest(state.path, name)}>
        {t("fileTree.contextMenu.delete")}
      </button>
      {state.isDir && (
        <button type="button" onClick={() => props.onNewFolder(state.path)}>
          {t("fileTree.contextMenu.newFolder")}
        </button>
      )}
      {state.isDir && (
        <button type="button" onClick={() => props.onNewFile(state.path)}>
          {t("fileTree.newFile")}
        </button>
      )}
    </div>
  );
}
