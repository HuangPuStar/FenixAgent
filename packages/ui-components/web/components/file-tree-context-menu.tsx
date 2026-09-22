/**
 * 文件树右键菜单（从 apps/web 的 `agent-panel/file-tree-view.tsx` 内联 `ContextMenu` 拆出）。
 *
 * 纯化取舍：
 * 1. 源实现直接接收整个 `FileTreeViewProps`，本包改为聚焦的 props 接口（同名同语义），
 *    作为公共组件不应把整个视图的 props 契约带入。
 * 2. i18n 从宿主的 `NS.COMPONENTS` 改为包内 `UI_COMPONENTS_NS`。
 * 3. `onReference` 保持源实现的语义：无参，引用当前选中项而非菜单指向项。
 */

import { Download, FilePlus2, FolderPlus, Loader2, MessageSquareQuote, Move, Pencil, Trash2 } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { cn } from "../lib/cn";

export interface FileTreeContextMenuState {
  x: number;
  y: number;
  path: string;
  isDir: boolean;
}

export interface FileTreeDownloadState {
  path: string;
  isDir: boolean;
  error: boolean;
}

/**
 * 菜单项公共样式（原 `.file-tree-context-menu button` 及其 `:hover` / `:focus-visible` 规则）。
 * 文字色单独留给调用方：危险项需要整项保持危险色（原 `.is-danger` 规则在悬停规则之后，覆盖了悬停文字色）。
 */
const MENU_ITEM_CLASS =
  "flex min-h-8 w-full items-center gap-2 rounded-[5px] px-[9px] py-1.5 text-left text-[12px] whitespace-nowrap hover:bg-surface-2 focus-visible:bg-surface-2 focus-visible:[outline:2px_solid_color-mix(in_srgb,var(--color-brand)_45%,transparent)] focus-visible:outline-offset-[-2px] disabled:opacity-[0.55]";

export interface FileTreeContextMenuProps {
  state: FileTreeContextMenuState;
  /** 当前下载状态；命中 state.path 时该项显示 loading / 重试文案。 */
  download?: FileTreeDownloadState | null;
  onReference: () => void;
  onDownload: (path: string, isDir: boolean) => void;
  onRenameRequest: (path: string, name: string) => void;
  onMoveRequest: (path: string) => void;
  onDeleteRequest: (path: string, name: string) => void;
  onNewFile: (parentPath: string) => void;
  onNewFolder: (parentPath: string) => void;
}

/** 文件树右键菜单；超出视口时自动贴边，渲染到 body 以避免被面板裁剪。 */
export function FileTreeContextMenu({
  state,
  download,
  onReference,
  onDownload,
  onRenameRequest,
  onMoveRequest,
  onDeleteRequest,
  onNewFile,
  onNewFolder,
}: FileTreeContextMenuProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: state.x, top: state.y });
  const name = state.path.split("/").pop() ?? state.path;
  const downloading = download?.path === state.path && !download.error;

  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const viewportPadding = 8;
    setPosition({
      left: Math.max(viewportPadding, Math.min(state.x, window.innerWidth - menu.offsetWidth - viewportPadding)),
      top: Math.max(viewportPadding, Math.min(state.y, window.innerHeight - menu.offsetHeight - viewportPadding)),
    });
  }, [state.x, state.y]);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[1000] flex min-w-[152px] flex-col gap-0.5 rounded-[8px] border border-border-subtle bg-surface-1 p-[5px] shadow-[0_12px_32px_rgb(15_23_42/18%)] [&_svg]:size-[15px] [&_svg]:shrink-0"
      role="menu"
      style={{ left: position.left, top: position.top }}
    >
      <button
        type="button"
        className={cn(MENU_ITEM_CLASS, "text-text-secondary hover:text-text-primary")}
        onClick={onReference}
      >
        <MessageSquareQuote aria-hidden />
        {t("fileTree.contextMenu.reference")}
      </button>
      <button
        type="button"
        className={cn(MENU_ITEM_CLASS, "text-text-secondary hover:text-text-primary")}
        disabled={downloading}
        onClick={() => onDownload(state.path, state.isDir)}
      >
        {downloading ? <Loader2 className="animate-spin" aria-hidden /> : <Download aria-hidden />}
        {download?.path === state.path
          ? download.error
            ? t("fileTree.retryDownload")
            : t("fileTree.downloading")
          : state.isDir
            ? t("fileTree.downloadZip")
            : t("fileTree.download")}
      </button>
      <button
        type="button"
        className={cn(MENU_ITEM_CLASS, "text-text-secondary hover:text-text-primary")}
        onClick={() => onRenameRequest(state.path, name)}
      >
        <Pencil aria-hidden />
        {t("fileTree.contextMenu.rename")}
      </button>
      <button
        type="button"
        className={cn(MENU_ITEM_CLASS, "text-text-secondary hover:text-text-primary")}
        onClick={() => onMoveRequest(state.path)}
      >
        <Move aria-hidden />
        {t("fileTree.contextMenu.move")}
      </button>
      <button
        type="button"
        className={cn(MENU_ITEM_CLASS, "text-destructive")}
        onClick={() => onDeleteRequest(state.path, name)}
      >
        <Trash2 aria-hidden />
        {t("fileTree.contextMenu.delete")}
      </button>
      {state.isDir && (
        <button
          type="button"
          className={cn(MENU_ITEM_CLASS, "text-text-secondary hover:text-text-primary")}
          onClick={() => onNewFolder(state.path)}
        >
          <FolderPlus aria-hidden />
          {t("fileTree.contextMenu.newFolder")}
        </button>
      )}
      {state.isDir && (
        <button
          type="button"
          className={cn(MENU_ITEM_CLASS, "text-text-secondary hover:text-text-primary")}
          onClick={() => onNewFile(state.path)}
        >
          <FilePlus2 aria-hidden />
          {t("fileTree.newFile")}
        </button>
      )}
    </div>,
    document.body,
  );
}
