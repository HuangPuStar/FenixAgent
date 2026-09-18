import {
  type FileTreeContextMenuState,
  type FileTreeDownloadState,
  FileTreeView,
  filterFileTree,
  parsePathsToTree,
  splitFileTreeSections,
} from "@fenix/ui-components";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * 文件树分区：FileTreeView（react-arborist 虚拟滚动 + 右键菜单 + 双分区）。
 *
 * 组件本身是纯展示的，不碰任何文件接口：真实宿主用一个容器把 fs API 与 WebSocket 事件
 * 接进来（源仓库的 FileTreeTab），这里用一个本文件的假数据 harness 顶替，
 * 覆盖 loading / stale / 空态 / 搜索结果 / 右键菜单 / 删除确认几种状态。
 */

const DEMO_PATHS = [
  "user/notes.md",
  "user/drafts/",
  "user/drafts/idea.md",
  "README.md",
  "report.pdf",
  "budget.xlsx",
  "archive.zip",
  "src/",
  "src/index.ts",
  "src/lib/",
  "src/lib/utils.ts",
];

const DEMO_TREE = parsePathsToTree(DEMO_PATHS);

export function FileTreeSection() {
  const { t: tDemo } = useTranslation(DEMO_NS);
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedIds, setExpandedIds] = useState<string[]>(["user", "user/drafts", "src", "src/lib"]);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [contextMenu, setContextMenu] = useState<FileTreeContextMenuState | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ path: string; name: string } | null>(null);
  const [download, setDownload] = useState<FileTreeDownloadState | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const normalizedSearch = searchQuery.trim().toLocaleLowerCase();
  const sections = splitFileTreeSections(DEMO_TREE);
  const workspaceNodes = filterFileTree(sections.workspace, normalizedSearch);
  const userNodes = filterFileTree(sections.user, normalizedSearch);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{tDemo("sections.fileTree")}</h1>

      <div className="demo-example">
        <h2 className="demo-example-title">FileTreeView</h2>
        <div className="demo-row" style={{ marginBottom: 12 }}>
          <button type="button" className="demo-nav-item" onClick={() => setLoading((value) => !value)}>
            loading: {String(loading)}
          </button>
          <button type="button" className="demo-nav-item" onClick={() => setStale((value) => !value)}>
            stale: {String(stale)}
          </button>
          {selected && <span className="demo-hint">selected: {selected}</span>}
        </div>
        {/* 树需要确定高度才能虚拟化：宿主里高度来自 artifacts 面板，这里给定值。 */}
        <div
          style={{ height: 460 }}
          className="flex overflow-hidden rounded-md border border-border bg-surface-1"
          onContextMenu={(event) => {
            if (event.target === event.currentTarget) setContextMenu(null);
          }}
        >
          <FileTreeView
            canMutate
            contextMenu={contextMenu}
            deleteConfirm={deleteConfirm}
            deleting={false}
            download={download}
            dragOver={false}
            expandedIds={expandedIds}
            fileInputRef={{ current: null }}
            folderInputRef={{ current: null }}
            hasSearchResults={workspaceNodes.length > 0 || userNodes.length > 0}
            loading={loading}
            normalizedSearch={normalizedSearch}
            onCloseDelete={() => setDeleteConfirm(null)}
            onConfirmDelete={() => {
              setDeleteConfirm(null);
              setContextMenu(null);
            }}
            onContextMenu={(event) => {
              const row = (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]");
              const path = row?.dataset.nodeId;
              const isDir = row?.dataset.isDir === "true";
              setContextMenu(path ? { x: event.clientX, y: event.clientY, path, isDir } : null);
            }}
            onDeleteRequest={(path, name) => setDeleteConfirm({ path, name })}
            onDownload={(path, isDir) => {
              setDownload({ path, isDir, error: false });
              setTimeout(() => setDownload(null), 1200);
            }}
            onDragEnter={() => {}}
            onDragLeave={() => {}}
            onDragOver={() => {}}
            onDrop={() => {}}
            onFileInputChange={() => {}}
            onFolderInputChange={() => {}}
            onFolderUploadClick={() => {}}
            onMoveRequest={() => {}}
            onNewFile={() => {}}
            onNewFolder={() => {}}
            onReference={() => setContextMenu(null)}
            onRefresh={() => {}}
            onRenameRequest={() => {}}
            onSearchChange={setSearchQuery}
            onSelect={(node) => setSelected(node.path)}
            onToggle={(nodeId, expanded) =>
              setExpandedIds((ids) => (expanded ? [...ids, nodeId] : ids.filter((id) => id !== nodeId)))
            }
            onUploadClick={() => {}}
            searchQuery={searchQuery}
            showTree
            stale={stale}
            treeVersion={0}
            uploading={false}
            userHasNodes={sections.user.length > 0}
            userNodes={userNodes}
            workspaceHasNodes={sections.workspace.length > 0}
            workspaceNodes={workspaceNodes}
          />
        </div>
        <p className="demo-hint">
          文件类型图标由 <code>FileTypeIcon</code>（react-file-icon）渲染，尺寸由组件自带的 16px 外框决定； 树里的 12px
          图标位靠 <code>max-h-full max-w-full</code> 收窄。
        </p>
      </div>
    </section>
  );
}
