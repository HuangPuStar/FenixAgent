import { type EditingCapabilities, type EditingClient, EditingError } from "@fenix/file-editing/contracts";
import {
  type EditableKind,
  EditingDialogs,
  EditingPane,
  type FileEditingController,
  useFileEditing,
} from "@fenix/file-editing/web";
import { FILE_EDITING_NS } from "@fenix/file-editing/web/i18n";
import type { ChangedFile } from "@fenix/ui-components/chat/lib/extract-changed-files";
import { PreviewTab } from "@fenix/ui-components/components/PreviewTab";
import { classifyFile } from "@fenix/ui-components/components/preview/preview-source";
import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { usePageFullscreen } from "@fenix/ui-components/ui/use-page-fullscreen";
import { useBlocker, useRouter } from "@tanstack/react-router";
import { Eye, Pencil } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { machineEditingClient } from "../api/file-editing";
import { buildPreviewSourceUrl, readPreviewSource } from "../api/fs";
import { useFileTreeLayout } from "../hooks/use-file-tree-layout";
import { FILE_TREE_DEFAULT_WIDTH, FILE_TREE_MIN_WIDTH } from "../lib/file-tree-layout";
import { remapWorkspaceFilePath, type WorkspaceFilesChange } from "../lib/workspace-file-operations";
import { FileTabsBar } from "./FileTabsBar";
import { FileTreeTab } from "./FileTreeTab";
import { FileTreeLayoutToggle } from "./file-tree-layout-toggle";
import { FileTreeWorkbench } from "./file-tree-workbench";

/** Host callbacks keep navigation and layout ownership outside the editing package. */
interface ArtifactsFilesWorkspaceProps {
  envId: string | null;
  openFiles: string[];
  activeFile: string | null;
  changedFiles: ChangedFile[];
  active?: boolean;
  editingClient?: EditingClient;
  onRegisterBeforeLeave?: (guard: (() => Promise<boolean>) | null) => void;
  onSelectFile: (path: string) => void;
  onCloseFile: (path: string) => void;
  onOpenFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
  onFilesChanged: (change: WorkspaceFilesChange) => void;
}

function readFileTreeWidth(): number {
  try {
    const width = Number(localStorage.getItem("fenix:file-tree-width"));
    return Number.isFinite(width) && width >= FILE_TREE_MIN_WIDTH ? width : FILE_TREE_DEFAULT_WIDTH;
  } catch {
    return FILE_TREE_DEFAULT_WIDTH;
  }
}

/** Classifies editable formats using the same file categories as the read-only preview. */
export function classifyWorkspaceEditor(
  path: string,
  office?: EditingCapabilities["office"] | null,
): EditableKind | null {
  const extension = path.split(".").pop()?.toLowerCase() ?? "";
  if (office?.enabled && office.extensions.some((value) => value.replace(/^\./, "").toLowerCase() === extension))
    return "office";
  const category = classifyFile(path);
  return ["code", "markdown", "html", "latex"].includes(category) || extension === "csv" || extension === "tsv"
    ? "text"
    : null;
}

/** Router-free embeds use the same workspace; only router-backed hosts register a blocker. */
function WorkspaceNavigationGuard({ controller }: { controller: FileEditingController }) {
  const guarded =
    controller.dirtyPaths.length > 0 || Object.values(controller.buffers).some((buffer) => buffer.kind === "office");
  useBlocker({
    disabled: !guarded,
    enableBeforeUnload: false,
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) return false;
      return !(await controller.beforeLeave());
    },
  });
  return null;
}

/** Keeps editor drafts and Office iframes alive independently of the host's small tab LRU. */
export function ArtifactsFilesWorkspace({
  envId,
  openFiles,
  activeFile,
  changedFiles,
  active = true,
  editingClient = machineEditingClient,
  onRegisterBeforeLeave,
  onSelectFile,
  onCloseFile,
  onOpenFile,
  onReferenceFile,
  onFilesChanged,
}: ArtifactsFilesWorkspaceProps) {
  const { t: tEditing } = useTranslation(FILE_EDITING_NS);
  const fullscreenState = usePageFullscreen(active);
  const router = useRouter({ warn: false });
  const { mode: treeLayout, isWideViewport, toggleMode } = useFileTreeLayout();
  const [treeOpen, setTreeOpen] = useState(() => treeLayout === "docked" || isWideViewport);
  const initialFileTreeWidthRef = useRef(readFileTreeWidth());
  const [treeRefresh, setTreeRefresh] = useState(0);
  const [previewRefresh, setPreviewRefresh] = useState(0);
  const [environmentVisit, setEnvironmentVisit] = useState(envId);
  const [editingFiles, setEditingFiles] = useState<string[]>([]);
  const [capabilityRetry, setCapabilityRetry] = useState(0);
  const [capabilities, setCapabilities] = useState<{
    environmentId: string | null;
    office: EditingCapabilities["office"] | null;
    error: Error | null;
    loading: boolean;
  }>({ environmentId: envId, office: null, error: null, loading: !!envId });
  const capabilityGeneration = useRef(0);
  const onSaved = useCallback(
    (file: { path: string }) => {
      setTreeRefresh((value) => value + 1);
      setPreviewRefresh((value) => value + 1);
      if (file.path === activeFile && !openFiles.includes(file.path)) onOpenFile(file.path);
    },
    [activeFile, openFiles, onOpenFile],
  );
  const editing = useFileEditing({ environmentId: envId ?? "", client: editingClient, onSaved });
  const { beforeLeave, guardPaths, notifyFileChange, notifyPathChange } = editing;
  useEffect(() => {
    setEnvironmentVisit(envId);
    setEditingFiles([]);
  }, [envId]);
  useEffect(() => {
    void capabilityRetry;
    const generation = ++capabilityGeneration.current;
    const abort = new AbortController();
    setCapabilities({ environmentId: envId, office: null, error: null, loading: !!envId });
    if (envId)
      void editingClient
        .capabilities(envId, abort.signal)
        .then((value) => {
          if (!abort.signal.aborted && generation === capabilityGeneration.current)
            setCapabilities({ environmentId: envId, office: value.office, error: null, loading: false });
        })
        .catch((error: unknown) => {
          if (!abort.signal.aborted && generation === capabilityGeneration.current)
            setCapabilities({
              environmentId: envId,
              office: null,
              error: error instanceof Error ? error : new EditingError("unavailable", String(error)),
              loading: false,
            });
        });
    return () => {
      abort.abort();
    };
  }, [envId, editingClient, capabilityRetry]);
  useEffect(() => {
    onRegisterBeforeLeave?.(beforeLeave);
    return () => onRegisterBeforeLeave?.(null);
  }, [beforeLeave, onRegisterBeforeLeave]);

  const environmentReady = environmentVisit === envId;
  const effectiveFiles = useMemo(
    () => [
      ...new Set([
        ...openFiles,
        ...editing.dirtyPaths,
        ...Object.values(editing.buffers)
          .filter((buffer) => buffer.kind === "office")
          .map((buffer) => buffer.path),
      ]),
    ],
    [openFiles, editing.dirtyPaths, editing.buffers],
  );
  const dirtyPaths = useMemo(() => new Set(editing.dirtyPaths), [editing.dirtyPaths]);
  useEffect(() => {
    setEditingFiles((paths) => {
      const kept = paths.filter((path) => path === activeFile || effectiveFiles.includes(path));
      return kept.length === paths.length ? paths : kept;
    });
  }, [effectiveFiles, activeFile]);
  const office = capabilities.environmentId === envId ? capabilities.office : null;
  const activeBuffer = activeFile ? editing.buffers[activeFile] : undefined;
  const editableKind =
    envId && activeFile && environmentReady
      ? activeBuffer?.session || activeBuffer?.dirty
        ? activeBuffer.kind
        : classifyWorkspaceEditor(activeFile, office)
      : null;
  const isEditing = Boolean(
    activeFile && (editingFiles.includes(activeFile) || activeBuffer?.dirty || activeBuffer?.session),
  );
  const kind = isEditing ? editableKind : null;
  const fallbackError =
    activeBuffer &&
    !activeBuffer.dirty &&
    !activeBuffer.session &&
    ["too-large", "not-editable", "unavailable"].includes(activeBuffer.error?.code ?? "")
      ? activeBuffer.error
      : null;
  const officePaths = environmentReady
    ? [
        ...new Set([
          ...Object.values(editing.buffers)
            .filter((buffer) => buffer.kind === "office" && (buffer.session || !buffer.error))
            .map((buffer) => buffer.path),
          ...(kind === "office" && activeFile && !fallbackError ? [activeFile] : []),
        ]),
      ]
    : [];

  const closeFile = useCallback(
    (path: string) => {
      void (async () => {
        if (!(await editing.requestClose(path))) return;
        setEditingFiles((paths) => paths.filter((file) => file !== path));
        onCloseFile(path);
        if (activeFile === path) {
          const next = effectiveFiles.find((candidate) => candidate !== path);
          if (next) onSelectFile(next);
        }
      })();
    },
    [editing.requestClose, onCloseFile, activeFile, effectiveFiles, onSelectFile],
  );
  const returnToPreview = useCallback(
    async (path: string) => {
      if (!(await guardPaths([path]))) return;
      setEditingFiles((paths) => paths.filter((file) => file !== path));
      setPreviewRefresh((value) => value + 1);
    },
    [guardPaths],
  );
  const beforeMutation = useCallback(
    (paths: readonly string[], mutation: "move" | "delete") => {
      if (mutation === "delete") return guardPaths(paths);
      const guarded = Object.values(editing.buffers)
        .filter(
          (buffer) =>
            (buffer.kind === "office" || buffer.saving) &&
            paths.some((path) => buffer.path === path || buffer.path.startsWith(`${path}/`)),
        )
        .map((buffer) => buffer.path);
      return guardPaths(guarded);
    },
    [editing.buffers, guardPaths],
  );
  const filesChanged = useCallback(
    (change: WorkspaceFilesChange) => {
      notifyPathChange(change);
      setEditingFiles((paths) =>
        paths.map((path) => remapWorkspaceFilePath(path, change)).filter((path): path is string => path !== null),
      );
      onFilesChanged(change);
      setPreviewRefresh((value) => value + 1);
    },
    [notifyPathChange, onFilesChanged],
  );
  const externalChange = useCallback(
    (change: Parameters<typeof notifyFileChange>[0]) => {
      notifyFileChange(change);
      setPreviewRefresh((value) => value + 1);
    },
    [notifyFileChange],
  );
  const manualRefresh = useCallback(() => externalChange({ kind: "invalidate-all", paths: [] }), [externalChange]);
  const handleTreeWidthChange = useCallback((width: number) => {
    try {
      localStorage.setItem("fenix:file-tree-width", String(width));
    } catch {
      /* Optional layout preference. */
    }
  }, []);
  const toggleTree = useCallback(() => setTreeOpen((open) => !open), []);
  const closeTree = useCallback(() => setTreeOpen(false), []);
  const switchLayoutMode = useCallback(() => {
    setTreeOpen(true);
    toggleMode();
  }, [toggleMode]);
  const officeCandidate =
    activeFile &&
    (classifyFile(activeFile) === "office" ||
      (classifyFile(activeFile) === "table" && !/\.(csv|tsv)$/i.test(activeFile)));
  const pendingOffice = officeCandidate && capabilities.loading;
  const previewActions =
    (!isEditing || fallbackError) && (editableKind || pendingOffice) ? (
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={tEditing(isEditing ? "preview" : "edit")}
        title={tEditing(isEditing ? "preview" : "edit")}
        disabled={pendingOffice || !editableKind}
        onClick={() => {
          if (!activeFile || !editableKind) return;
          if (isEditing) {
            void returnToPreview(activeFile);
            return;
          }
          setEditingFiles((paths) => [...new Set([...paths, activeFile])]);
          void editing.ensureLoaded(activeFile, editableKind);
        }}
      >
        {isEditing ? <Eye aria-hidden="true" /> : <Pencil aria-hidden="true" />}
      </Button>
    ) : null;
  const preview = (
    <PreviewTab
      key={`${envId}:${activeFile}:${previewRefresh}`}
      envId={envId}
      filePath={environmentReady ? activeFile : null}
      buildPreviewUrl={buildPreviewSourceUrl}
      fetchPreview={readPreviewSource}
      toolbarActions={previewActions}
      fullscreenState={fullscreenState}
    />
  );
  return (
    <>
      {router && <WorkspaceNavigationGuard controller={editing} />}
      <FileTreeWorkbench
        layout={treeLayout}
        initialTreeWidth={initialFileTreeWidthRef.current}
        onTreeWidthChange={handleTreeWidthChange}
        treeOpen={treeOpen}
        onToggleTree={toggleTree}
        tree={
          <FileTreeTab
            key={envId ?? "no-environment"}
            envId={envId}
            onPreviewFile={onOpenFile}
            onReferenceFile={onReferenceFile}
            onFilesChanged={filesChanged}
            onExternalFileChange={externalChange}
            onManualRefresh={manualRefresh}
            refreshVersion={treeRefresh}
            beforeMutation={beforeMutation}
            headerActions={<FileTreeLayoutToggle mode={treeLayout} onToggleMode={switchLayoutMode} />}
          />
        }
        preview={
          <>
            <FileTabsBar
              openFiles={environmentReady ? effectiveFiles : openFiles}
              activeFile={activeFile}
              changedFiles={changedFiles}
              dirtyPaths={dirtyPaths}
              onSelectFile={onSelectFile}
              onCloseFile={closeFile}
              onPreviewChangedFile={onOpenFile}
            />
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {((isEditing && fallbackError) || (capabilities.error && officeCandidate)) && (
                <div role="alert" className="flex items-center gap-2 border-b border-border p-3 text-sm text-red-500">
                  <span>
                    {tEditing(fallbackError?.message ?? capabilities.error?.message ?? "loadFailed", {
                      defaultValue: fallbackError?.message ?? capabilities.error?.message,
                    })}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (isEditing && fallbackError && activeFile) void editing.reload(activeFile);
                      else setCapabilityRetry((value) => value + 1);
                    }}
                  >
                    {tEditing("retry")}
                  </Button>
                </div>
              )}
              {kind === "text" && activeFile && !fallbackError ? (
                <EditingPane
                  key={`${envId}:${activeFile}`}
                  controller={editing}
                  path={activeFile}
                  kind="text"
                  fullscreenState={fullscreenState}
                  downloadUrl={envId ? buildPreviewSourceUrl(envId, activeFile) : undefined}
                  active={active}
                  onPreview={() => {
                    void returnToPreview(activeFile);
                  }}
                />
              ) : kind !== "office" || fallbackError ? (
                isEditing && pendingOffice ? (
                  <Spinner variant="panel" label={tEditing("loading")} />
                ) : (
                  preview
                )
              ) : null}
              {officePaths.map((path) => (
                <div
                  key={`${envId}:${path}`}
                  className={path === activeFile && !fallbackError ? "min-h-0 flex-1" : "hidden"}
                >
                  <EditingPane
                    controller={editing}
                    path={path}
                    kind="office"
                    fullscreenState={path === activeFile ? fullscreenState : undefined}
                    downloadUrl={envId ? buildPreviewSourceUrl(envId, path) : undefined}
                    active={active && isEditing && path === activeFile}
                    onPreview={() => {
                      void returnToPreview(path);
                    }}
                  />
                </div>
              ))}
              {treeLayout === "floating" && treeOpen && (
                <div data-slot="file-tree-overlay-backdrop" className="absolute inset-0 z-10" onClick={closeTree} />
              )}
            </div>
          </>
        }
      />
      <EditingDialogs controller={editing} />
    </>
  );
}
