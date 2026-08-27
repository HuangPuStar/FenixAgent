import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { type MouseEvent as ReactMouseEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { DemoScenarioId } from "./demo-model";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./demo-ui";
import { useDemoTranslation } from "./use-demo-copy";

type FolderId = "docs" | "web" | "user";

interface CreatedFile {
  id: number;
  folder: FolderId;
  name: string;
}

interface FileNode {
  id: string;
  folder: FolderId;
  label: string;
  changed?: boolean;
}

const USER_FILE_LABELS: Record<string, string> = {
  userBriefFile: "chat-redesign-brief.md",
  userReferenceFile: "chat-reference.png",
};

/** Local VS Code-like explorer used by the Chat design sandbox. */
export function FilesPanel({ scenarioId }: { scenarioId: DemoScenarioId }) {
  const { t } = useDemoTranslation();
  const [openFolders, setOpenFolders] = useState<Record<FolderId, boolean>>({ docs: true, web: true, user: true });
  const initialFile = scenarioId === "tools" ? "toolFile" : scenarioId === "files" ? "guidelineFile" : "selectedFile";
  const [selectedFile, setSelectedFile] = useState(initialFile);
  const [tabOpen, setTabOpen] = useState(true);
  const [fileQuery, setFileQuery] = useState("");
  const [creatingIn, setCreatingIn] = useState<FolderId | null>(null);
  const [createdFiles, setCreatedFiles] = useState<CreatedFile[]>([]);
  const [deletedNodes, setDeletedNodes] = useState<Set<string>>(() => new Set());
  const [treeMenu, setTreeMenu] = useState<{ x: number; y: number; id: string; label: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; label: string } | null>(null);
  const createdFileIdRef = useRef(0);

  const staticFiles = useMemo<FileNode[]>(
    () => [
      { id: "guidelineFile", folder: "docs", label: t("context.guidelineFile"), changed: true },
      { id: "apiMigrationFile", folder: "docs", label: t("context.apiMigrationFile") },
      { id: "toolFile", folder: "web", label: t("context.toolFile"), changed: true },
      { id: "selectedFile", folder: "web", label: t("context.selectedFile") },
      { id: "userBriefFile", folder: "user", label: USER_FILE_LABELS.userBriefFile },
      { id: "userReferenceFile", folder: "user", label: USER_FILE_LABELS.userReferenceFile },
    ],
    [t],
  );
  const allFiles = useMemo<FileNode[]>(
    () => [
      ...staticFiles,
      ...createdFiles.map((file) => ({ id: `created:${file.id}`, folder: file.folder, label: file.name })),
    ],
    [createdFiles, staticFiles],
  );
  const selectedFileLabel = allFiles.find((file) => file.id === selectedFile)?.label ?? selectedFile;
  const normalizedQuery = fileQuery.trim().toLocaleLowerCase();
  const folderLabels: Record<FolderId, string> = {
    docs: t("context.rootDocs"),
    web: t("context.rootWeb"),
    user: "用户",
  };
  const visibleFiles = (folder: FolderId) => {
    const folderMatches = folderLabels[folder].toLocaleLowerCase().includes(normalizedQuery);
    return allFiles.filter(
      (file) =>
        file.folder === folder &&
        !deletedNodes.has(file.id) &&
        (!normalizedQuery || folderMatches || file.label.toLocaleLowerCase().includes(normalizedQuery)),
    );
  };
  const hasSearchResults = (["docs", "web", "user"] as const).some(
    (folder) => !deletedNodes.has(folder) && visibleFiles(folder).length > 0,
  );

  const selectFile = (file: string) => {
    setSelectedFile(file);
    setTabOpen(true);
  };
  const toggleFolder = (folder: FolderId) => {
    setOpenFolders((folders) => ({ ...folders, [folder]: !folders[folder] }));
  };
  const startCreating = (folder: FolderId) => {
    setOpenFolders((folders) => ({ ...folders, [folder]: true }));
    setCreatingIn(folder);
  };
  const commitNewFile = (folder: FolderId, name: string) => {
    const trimmed = name.trim();
    if (trimmed) {
      createdFileIdRef.current += 1;
      setCreatedFiles((files) => [...files, { id: createdFileIdRef.current, folder, name: trimmed }]);
    }
    setCreatingIn(null);
  };
  const openTreeMenu = (event: ReactMouseEvent, id: string, label: string) => {
    event.preventDefault();
    event.stopPropagation();
    const workspaceBounds = event.currentTarget.closest(".chat-demo__vscode")?.getBoundingClientRect();
    setTreeMenu({
      x: event.clientX - (workspaceBounds?.left ?? 0),
      y: event.clientY - (workspaceBounds?.top ?? 0),
      id,
      label,
    });
  };
  const deleteTreeNode = () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    if (id.startsWith("created:")) {
      const createdId = Number(id.slice("created:".length));
      setCreatedFiles((files) => files.filter((file) => file.id !== createdId));
    } else {
      setDeletedNodes((nodes) => new Set(nodes).add(id));
    }

    const deletesActiveFile =
      id === selectedFile ||
      (["docs", "web", "user"] as const).some(
        (folder) => id === folder && allFiles.some((file) => file.folder === folder && file.id === selectedFile),
      );
    if (deletesActiveFile) setTabOpen(false);
    setDeleteTarget(null);
  };
  const renderFolder = (folder: FolderId, isUserArea = false) => {
    const files = visibleFiles(folder);
    if (normalizedQuery && files.length === 0) return null;
    return (
      <TreeFolder
        key={folder}
        label={folderLabels[folder]}
        open={normalizedQuery ? true : openFolders[folder]}
        userArea={isUserArea}
        onToggle={() => toggleFolder(folder)}
        onAdd={() => startCreating(folder)}
        onContextMenu={(event) => openTreeMenu(event, folder, folderLabels[folder])}
      >
        {files.map((file) => (
          <TreeFile
            key={file.id}
            label={file.label}
            active={selectedFile === file.id}
            changed={file.changed}
            onSelect={() => selectFile(file.id)}
            onContextMenu={(event) => openTreeMenu(event, file.id, file.label)}
          />
        ))}
        {creatingIn === folder && <NewTreeItem onCommit={(name) => commitNewFile(folder, name)} />}
      </TreeFolder>
    );
  };
  const renderUserFiles = () => {
    const files = visibleFiles("user");
    return (
      <>
        {files.map((file) => (
          <TreeFile
            key={file.id}
            label={file.label}
            active={selectedFile === file.id}
            changed={file.changed}
            onSelect={() => selectFile(file.id)}
            onContextMenu={(event) => openTreeMenu(event, file.id, file.label)}
          />
        ))}
        {creatingIn === "user" && <NewTreeItem onCommit={(name) => commitNewFile("user", name)} />}
      </>
    );
  };

  return (
    <div className="chat-demo__vscode" onClick={() => treeMenu && setTreeMenu(null)}>
      <div className="chat-demo__vscode-body">
        <section className="chat-demo__vscode-explorer">
          <header>
            <strong className="chat-demo__explorer-title">{t("context.explorer")}</strong>
            <div className="chat-demo__schedule-copy">
              <button type="button" aria-label="在用户文件中新建" onClick={() => startCreating("user")}>
                <Plus />
              </button>
              <button type="button" aria-label={t("context.more")}>
                <MoreHorizontal />
              </button>
            </div>
          </header>
          <label className="chat-demo__file-search">
            <Search />
            <input
              value={fileQuery}
              aria-label="搜索文件"
              placeholder="搜索文件"
              onChange={(event) => setFileQuery(event.target.value)}
            />
            {fileQuery && (
              <button type="button" aria-label="清除文件搜索" onClick={() => setFileQuery("")}>
                <X />
              </button>
            )}
          </label>
          <div className="chat-demo__explorer-workspace">
            <div className="chat-demo__vscode-root">{t("context.workspaceRoot")}</div>
            {!deletedNodes.has("docs") && renderFolder("docs")}
            {!deletedNodes.has("web") && renderFolder("web")}
            {normalizedQuery && !hasSearchResults && <p className="chat-demo__file-search-empty">没有匹配的文件</p>}
          </div>
          {!deletedNodes.has("user") && (
            <section className="chat-demo__user-files-area" aria-label="用户">
              <div className="chat-demo__user-files-label">
                <UserRound />
                <span>用户</span>
                <small>当前用户</small>
              </div>
              <div className="chat-demo__user-files-list">{renderUserFiles()}</div>
            </section>
          )}
        </section>
        <section className="chat-demo__vscode-workbench">
          <div className="chat-demo__file-tabs">
            {tabOpen ? (
              <div className="is-active">
                <FileText />
                <span>{selectedFileLabel}</span>
                <button type="button" aria-label={t("context.closeFile")} onClick={() => setTabOpen(false)}>
                  <X />
                </button>
              </div>
            ) : (
              <span>{t("context.noOpenFiles")}</span>
            )}
          </div>
          <section className="chat-demo__vscode-editor">
            {tabOpen ? (
              <>
                <div>
                  <span>1</span>
                  <code>{t("context.fileContentLine1")}</code>
                </div>
                <div>
                  <span>2</span>
                  <code />
                </div>
                <div>
                  <span>3</span>
                  <code>{t("context.fileContentLine3")}</code>
                </div>
                <div>
                  <span>4</span>
                  <code>{t("context.fileContentLine4")}</code>
                </div>
                <div>
                  <span>5</span>
                  <code>{t("context.fileContentLine5")}</code>
                </div>
              </>
            ) : (
              <p>{t("context.selectFileHint")}</p>
            )}
          </section>
        </section>
      </div>
      {treeMenu && (
        <div className="chat-demo__tree-context-menu" style={{ left: treeMenu.x, top: treeMenu.y }} role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              setDeleteTarget({ id: treeMenu.id, label: treeMenu.label });
              setTreeMenu(null);
            }}
          >
            <Trash2 />
            删除
          </button>
        </div>
      )}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent className="max-w-[360px]">
          <AlertDialogHeader>
            <AlertDialogTitle>删除“{deleteTarget?.label}”？</AlertDialogTitle>
            <AlertDialogDescription>此操作只改变当前设计沙盘的本地 mock 状态。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={deleteTreeNode}>删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function TreeFolder({
  label,
  open,
  userArea = false,
  onToggle,
  onAdd,
  onContextMenu,
  children,
}: {
  label: string;
  open: boolean;
  userArea?: boolean;
  onToggle: () => void;
  onAdd: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <div className={`chat-demo__tree-folder${userArea ? " is-user-area" : ""}`}>
      <div className="chat-demo__tree-folder-row" onContextMenu={onContextMenu}>
        <button type="button" className="chat-demo__tree-folder-toggle" onClick={onToggle}>
          {open ? <ChevronDown /> : <ChevronRight />}
          {open ? <FolderOpen /> : <Folder />}
          <span>{label}</span>
        </button>
        <button type="button" className="chat-demo__tree-folder-add" aria-label={`在 ${label} 中新建`} onClick={onAdd}>
          <Plus />
        </button>
      </div>
      {open && <div className="chat-demo__tree-folder-children">{children}</div>}
    </div>
  );
}

function NewTreeItem({ onCommit }: { onCommit: (name: string) => void }) {
  const [name, setName] = useState("untitled.md");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <div className="chat-demo__tree-new-item">
      <FileCode2 />
      <input
        ref={inputRef}
        value={name}
        aria-label="新文件名称"
        onChange={(event) => setName(event.target.value)}
        onBlur={() => onCommit(name)}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") onCommit("");
        }}
      />
    </div>
  );
}

function TreeFile({
  label,
  active,
  changed = false,
  onSelect,
  onContextMenu,
}: {
  label: string;
  active: boolean;
  changed?: boolean;
  onSelect: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
}) {
  return (
    <div className={`chat-demo__tree-file${active ? " is-selected" : ""}`} onContextMenu={onContextMenu}>
      <button type="button" className="chat-demo__tree-file-open" aria-label={`打开 ${label}`} onClick={onSelect}>
        <ExternalLink />
      </button>
      <button type="button" className="chat-demo__tree-file-name" title={label} onClick={onSelect}>
        <span>{label}</span>
        {changed && <i>M</i>}
      </button>
    </div>
  );
}
