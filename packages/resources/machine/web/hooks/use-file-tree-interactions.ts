import type { FileTreeContextMenuState } from "@fenix/ui-components/components/file-tree-context-menu";
import {
  type FileTreeSelection,
  type FileTreeSelectionGesture,
  findFileNode,
  getRootFileTreePaths,
  type ParsedFileNode,
  selectFileTreePaths,
} from "@fenix/ui-components/components/file-tree-model";
import { type DragEvent, type MouseEvent, useCallback, useEffect, useRef, useState } from "react";
import { planWorkspaceFileMoves } from "../lib/workspace-file-operations";
import { useDragCounter } from "./use-drag-counter";

/** 仅本文件树的活动拖动会话可以消费此 MIME，外部文件仍走 Files 上传。 */
export const FILE_TREE_DRAG_MIME = "application/x-fenix-workspace-paths";

interface FileTreeInteractionsOptions {
  envId: string | null;
  searchQuery: string;
  treeVersion: number;
  getTree: () => ParsedFileNode[];
  visiblePaths: string[];
  enabled: boolean;
  onPreviewFile: (path: string) => void;
  moveToDirectory: (paths: string[], target: string) => Promise<boolean>;
  uploadDroppedFiles: (transfer: DataTransfer, target: string) => Promise<unknown>;
}

interface InternalDrag {
  envId: string;
  paths: string[];
  payload: string;
}

/** 双分区交互状态的唯一持有者，区分选择、菜单、内部移动与外部上传。 */
export function useFileTreeInteractions(options: FileTreeInteractionsOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [selection, setSelection] = useState<FileTreeSelection>({ paths: [], anchor: null });
  const selectionRef = useRef(selection);
  const [contextMenu, setContextMenu] = useState<FileTreeContextMenuState | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const dragRef = useRef<InternalDrag | null>(null);
  const scopeRef = useRef({ envId: options.envId, searchQuery: options.searchQuery });
  const treeVersionRef = useRef(options.treeVersion);
  const upload = useDragCounter();

  const applySelection = useCallback((next: FileTreeSelection) => {
    selectionRef.current = next;
    setSelection(next);
  }, []);
  const setSelectedPaths = useCallback(
    (paths: string[]) => {
      applySelection({ paths, anchor: paths.at(-1) ?? null });
    },
    [applySelection],
  );
  const clearSelection = useCallback(() => {
    applySelection({ paths: [], anchor: null });
    setContextMenu(null);
  }, [applySelection]);

  useEffect(() => {
    if (scopeRef.current.envId === options.envId && scopeRef.current.searchQuery === options.searchQuery) return;
    scopeRef.current = { envId: options.envId, searchQuery: options.searchQuery };
    clearSelection();
    dragRef.current = null;
    setDropTarget(null);
    upload.resetDragCounter();
  }, [options.envId, options.searchQuery, clearSelection, upload.resetDragCounter]);

  useEffect(() => {
    if (treeVersionRef.current === options.treeVersion) return;
    treeVersionRef.current = options.treeVersion;
    const existing = selectionRef.current.paths.filter((path) => findFileNode(optionsRef.current.getTree(), path));
    if (existing.length !== selectionRef.current.paths.length) setSelectedPaths(existing);
    setContextMenu(null);
  }, [options.treeVersion, setSelectedPaths]);

  useEffect(() => {
    if (!contextMenu) return;
    const dismiss = (event: globalThis.Event) => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "pointerdown" && (event.target as Element)?.closest?.('[role="menu"]')) return;
      setContextMenu(null);
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", dismiss);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", dismiss);
    };
  }, [contextMenu]);

  function handleSelect(node: ParsedFileNode, gesture: FileTreeSelectionGesture) {
    setContextMenu(null);
    applySelection(selectFileTreePaths(selectionRef.current, node.path, optionsRef.current.visiblePaths, gesture));
    if (!node.isDir && !gesture.toggle && !gesture.range) optionsRef.current.onPreviewFile(node.path);
  }

  function handleContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const target = event.target as Element;
    const element =
      target.closest<HTMLElement>("[data-tree-item]") ??
      target.closest('[role="treeitem"]')?.querySelector<HTMLElement>("[data-tree-item]");
    const path = element?.dataset.nodeId;
    const node = path ? findFileNode(optionsRef.current.getTree(), path) : null;
    if (!node || !path) {
      setContextMenu(null);
      return;
    }
    const paths = selectionRef.current.paths.includes(path) ? [...selectionRef.current.paths] : [path];
    if (!selectionRef.current.paths.includes(path)) setSelectedPaths(paths);
    element?.closest<HTMLElement>('[role="treeitem"]')?.focus({ preventScroll: true });
    const bounds = element?.getBoundingClientRect();
    const keyboard = event.clientX === 0 && event.clientY === 0;
    setContextMenu({
      x: keyboard ? (bounds?.left ?? 0) : event.clientX,
      y: keyboard ? (bounds?.bottom ?? 0) : event.clientY,
      path,
      isDir: node.isDir,
      paths,
    });
  }

  function handleDragStart(event: DragEvent<HTMLDivElement>, path: string) {
    const { envId, enabled, getTree } = optionsRef.current;
    if (!envId || !enabled || path === "user" || !findFileNode(getTree(), path)) {
      event.preventDefault();
      return;
    }
    const paths = getRootFileTreePaths(selectionRef.current.paths.includes(path) ? selectionRef.current.paths : [path]);
    if (!selectionRef.current.paths.includes(path)) setSelectedPaths([path]);
    const payload = JSON.stringify({ envId, paths });
    dragRef.current = { envId, paths, payload };
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(FILE_TREE_DRAG_MIME, payload);
    setContextMenu(null);
  }

  function handleDragEnd() {
    dragRef.current = null;
    setDropTarget(null);
  }

  const internal = (event: DragEvent<HTMLDivElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes(FILE_TREE_DRAG_MIME);
  const externalFiles = (event: DragEvent<HTMLDivElement>) =>
    Array.from(event.dataTransfer?.types ?? []).includes("Files");
  function targetDirectory(event: DragEvent<HTMLDivElement>): string | null {
    const element = event.target as Element;
    const node = element.closest<HTMLElement>("[data-node-id]");
    if (node) return node.dataset.isDir === "true" ? (node.dataset.nodeId ?? null) : null;
    return element.closest<HTMLElement>("[data-upload-target]")?.dataset.uploadTarget ?? null;
  }
  function allowedTarget(event: DragEvent<HTMLDivElement>): string | null {
    const drag = dragRef.current;
    if (!drag || !optionsRef.current.enabled || drag.envId !== optionsRef.current.envId) return null;
    const target = targetDirectory(event);
    if (target === null) return null;
    const plan = planWorkspaceFileMoves(drag.paths, target, optionsRef.current.getTree());
    return plan.moves.length || plan.failed.some((failure) => failure.reason === "conflict") ? target : null;
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (internal(event)) {
      event.preventDefault();
      event.stopPropagation();
      const target = allowedTarget(event);
      setDropTarget(target);
      event.dataTransfer.dropEffect = target === null ? "none" : "move";
    } else if (externalFiles(event) && optionsRef.current.enabled) {
      upload.handleDragOver(event);
    }
  }
  function handleDragEnter(event: DragEvent<HTMLDivElement>) {
    if (internal(event)) handleDragOver(event);
    else if (externalFiles(event) && optionsRef.current.enabled) upload.handleDragEnter(event);
  }
  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    if (internal(event)) {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropTarget(null);
    } else if (externalFiles(event)) upload.handleDragLeave(event);
  }
  function handleDrop(event: DragEvent<HTMLDivElement>, uploadTarget?: string) {
    event.preventDefault();
    upload.resetDragCounter();
    if (internal(event)) {
      event.stopPropagation();
      const drag = dragRef.current;
      const target = allowedTarget(event);
      // 拖动数据只与本次可信快照比对，绝不把外部 MIME 中的路径作为写请求输入。
      const valid = drag && target !== null && event.dataTransfer.getData(FILE_TREE_DRAG_MIME) === drag.payload;
      handleDragEnd();
      if (valid && drag && target !== null) void optionsRef.current.moveToDirectory(drag.paths, target);
    } else if (externalFiles(event) && optionsRef.current.enabled) {
      void optionsRef.current.uploadDroppedFiles(event.dataTransfer, uploadTarget ?? "");
    }
  }

  return {
    selectedPaths: selection.paths,
    setSelectedPaths,
    clearSelection,
    contextMenu,
    closeContextMenu: () => setContextMenu(null),
    dropTarget,
    dragOver: upload.isDragging,
    handleSelect,
    handleContextMenu,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragEnter,
    handleDragLeave,
    handleDrop,
  };
}
