import {
  Download,
  FilePlus2,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Loader2,
  Move,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  UserRound,
  X,
} from "lucide-react";
import type { ChangeEvent, DragEvent, MouseEvent, ReactNode, RefObject } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { NodeRendererProps } from "react-arborist";
import { Tree as ArboristTree } from "react-arborist";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { FileTypeIcon } from "@/src/components/file-icon-helper";
import { NS } from "../../i18n";
import type { ParsedFileNode } from "./file-tree-model";

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
  workspaceHasNodes: boolean;
  userHasNodes: boolean;
  expandedIds: string[];
  contextMenu: ContextMenuState | null;
  deleteConfirm: { path: string; name: string } | null;
  fileInputRef: RefObject<HTMLInputElement | null>;
  folderInputRef: RefObject<HTMLInputElement | null>;
  workspaceNodes: ParsedFileNode[];
  userNodes: ParsedFileNode[];
  onSelect: (node: ParsedFileNode) => void;
  onToggle: (nodeId: string, expanded: boolean) => void;
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
  onRenameRequest: (path: string, name: string) => void;
  onMoveRequest: (path: string) => void;
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
            onClick={props.onRefresh}
            disabled={props.loading || !props.envId}
            title={t("fileTree.refresh")}
            aria-label={t("fileTree.refresh")}
          >
            <RefreshCw className={props.loading ? "animate-spin" : undefined} aria-hidden />
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

      <div
        className="file-tree-sections"
        onDragOver={props.onDragOver}
        onDragEnter={props.onDragEnter}
        onDragLeave={props.onDragLeave}
        onDrop={props.onDrop}
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

const FILE_TREE_WORKSPACE_MIN_HEIGHT = "112px";
const FILE_TREE_USER_MIN_HEIGHT = "68px";

function FileTreeSections(props: FileTreeViewProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  return (
    <ResizablePanelGroup orientation="vertical" className="file-tree-sections-resizable">
      <ResizablePanel defaultSize="60%" minSize={FILE_TREE_WORKSPACE_MIN_HEIGHT}>
        <section className="file-tree-section file-tree-section--workspace">
          <div className="file-tree-workspace-label">{t("fileTree.workspace")}</div>
          <div className="file-tree-section-scroll">
            {props.showTree && props.workspaceHasNodes ? (
              <ArboristFileTree
                key={`workspace:${props.treeVersion}:${props.normalizedSearch}`}
                data={props.workspaceNodes}
                {...props}
              />
            ) : (
              <Feedback icon={<Folder />} text={t("fileTree.emptyState")} detail={t("fileTree.emptyHint")} />
            )}
          </div>
        </section>
      </ResizablePanel>
      <ResizableHandle className="file-tree-sections-divider" />
      <ResizablePanel defaultSize="40%" minSize={FILE_TREE_USER_MIN_HEIGHT}>
        <section className="file-tree-section file-tree-section--user">
          <div className="file-tree-user-heading">
            <UserRound aria-hidden />
            <span>{t("fileTree.user")}</span>
          </div>
          <div className="file-tree-section-scroll">
            {props.showTree && props.userHasNodes ? (
              <ArboristFileTree
                key={`user:${props.treeVersion}:${props.normalizedSearch}`}
                data={props.userNodes}
                {...props}
              />
            ) : (
              <Feedback icon={<Folder />} text={t("fileTree.userEmptyState")} />
            )}
          </div>
        </section>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}

function ArboristFileTree({ data, ...props }: { data: ParsedFileNode[] } & FileTreeViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(0);
  const initialOpenState = useMemo(
    () => Object.fromEntries(props.expandedIds.map((id) => [id, true])),
    [props.expandedIds],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const updateHeight = () => setHeight(container.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const Node = useCallback(
    (rendererProps: NodeRendererProps<ParsedFileNode>) => <FileTreeNode {...rendererProps} viewProps={props} />,
    [props],
  );

  return (
    <div ref={containerRef} className="file-tree-arborist">
      {height > 0 && (
        <ArboristTree
          data={data}
          idAccessor="path"
          childrenAccessor="children"
          initialOpenState={initialOpenState}
          openByDefault={false}
          disableDrag
          disableDrop
          disableEdit
          disableMultiSelection
          rowHeight={32}
          indent={12}
          overscanCount={8}
          width="100%"
          height={height}
          aria-label="File tree"
        >
          {Node}
        </ArboristTree>
      )}
    </div>
  );
}

function FileTreeNode({
  node,
  style,
  dragHandle,
  viewProps: props,
}: NodeRendererProps<ParsedFileNode> & { viewProps: FileTreeViewProps }) {
  const { t } = useTranslation(NS.COMPONENTS);
  const data = node.data;
  const handleSelect = () => {
    node.select();
    props.onSelect(data);
    if (data.isDir) {
      const expanded = !node.isOpen;
      node.toggle();
      props.onToggle(data.path, expanded);
    }
  };
  const handleToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    const expanded = !node.isOpen;
    node.toggle();
    props.onToggle(data.path, expanded);
  };

  return (
    <div
      ref={dragHandle}
      style={{ ...style, paddingLeft: node.level * 12 + 8 }}
      className={`file-tree-arborist-row group${node.isSelected ? " is-selected" : ""}`}
      data-tree-item
      data-node-id={data.path}
      onClick={handleSelect}
    >
      <button
        type="button"
        className="file-tree-arborist-toggle"
        aria-label={data.name}
        onClick={data.isDir ? handleToggle : undefined}
      >
        {data.isDir ? (
          node.isOpen ? (
            <FolderOpen aria-hidden />
          ) : (
            <Folder aria-hidden />
          )
        ) : (
          <span className="file-tree-arborist-icon">
            <FileTypeIcon filename={data.name} />
          </span>
        )}
      </button>
      <span className="file-tree-arborist-name" title={data.name}>
        {data.name}
      </span>
      <span data-slot="tree-item-actions" className="file-tree-arborist-actions">
        {data.isDir && (
          <button
            type="button"
            className="file-tree-row-action"
            title={t("fileTree.newFile")}
            onClick={(event) => {
              event.stopPropagation();
              props.onNewFile(data.path);
            }}
          >
            <FilePlus2 aria-hidden />
          </button>
        )}
        <button
          type="button"
          className="file-tree-row-action"
          title={t("fileTree.refresh")}
          onClick={(event) => {
            event.stopPropagation();
            props.onRefresh();
          }}
        >
          <RefreshCw aria-hidden />
        </button>
        <button
          type="button"
          className="file-tree-row-action file-tree-row-action--delete"
          title={t("fileTree.contextMenu.delete")}
          onClick={(event) => {
            event.stopPropagation();
            props.onDeleteRequest(data.path, data.name);
          }}
        >
          <Trash2 aria-hidden />
        </button>
      </span>
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
      <button type="button" onClick={() => props.onRenameRequest(state.path, name)}>
        {t("fileTree.contextMenu.rename")}
      </button>
      <button type="button" onClick={() => props.onMoveRequest(state.path)}>
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
