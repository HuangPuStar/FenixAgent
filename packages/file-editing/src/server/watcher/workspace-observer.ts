import { lstat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { createLogger } from "@fenix/logger";
import { watch } from "chokidar";

/** Existing Machine file-event kinds forwarded without introducing another event channel. */
export type WorkspaceChangeKind = "add" | "change" | "unlink" | "addDir" | "unlinkDir";
/** A host-scoped directory and its event bridge; the host owns reference counting. */
export interface WorkspaceObserverOptions {
  root: string;
  onChange(path: string, kind: WorkspaceChangeKind): void;
}
/** A watcher that can be awaited during startup and symmetrically released. */
export interface WorkspaceObserver {
  ready: Promise<void>;
  close(): Promise<void>;
}

function isNoise(path: string): boolean {
  return path
    .split(/[\\/]/)
    .some(
      (part) =>
        [".git", ".svn", "node_modules", ".DS_Store"].includes(part) ||
        part.startsWith("~$") ||
        part.endsWith("~") ||
        /\.(sw[opx]|tmp)$/.test(part),
    );
}

/** Watch only the injected workspace root, skipping initial content, links and temporary noise. */
export function createWorkspaceObserver({ root, onChange }: WorkspaceObserverOptions): WorkspaceObserver {
  if (!isAbsolute(root)) throw new Error("Workspace observer root must be absolute");
  let closed = false;
  let closing: Promise<void> | undefined;
  const watcher = watch(root, {
    ignoreInitial: true,
    followSymlinks: false,
    ignored: (path, stats) => Boolean(stats?.isSymbolicLink()) || isNoise(relative(root, path)),
    awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 25 },
  });
  let readyResolve = () => {};
  let readyReject: (error: unknown) => void = () => {};
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const reportError = (error: unknown) => {
    createLogger("file-editing-watcher").warn("Workspace observer failed", {
      errorType: error instanceof Error ? error.name : typeof error,
    });
    readyReject(error);
  };
  watcher.once("ready", readyResolve);
  watcher.on("error", reportError);
  watcher.on("all", (kind, absolute, stats) => {
    if (closed || !["add", "change", "unlink", "addDir", "unlinkDir"].includes(kind) || stats?.isSymbolicLink()) return;
    const path = relative(root, absolute);
    if (!path || isAbsolute(path) || path.startsWith(`..${sep}`) || path === ".." || isNoise(path)) return;
    if (kind === "unlink" || kind === "unlinkDir") {
      onChange(path.split(sep).join("/"), kind);
      return;
    }
    // followSymlinks=false also emits link events without stats on some platforms.
    void lstat(absolute).then(
      (stat) => {
        if (!closed && !stat.isSymbolicLink()) onChange(path.split(sep).join("/"), kind as WorkspaceChangeKind);
      },
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") reportError(error);
      },
    );
  });
  return {
    ready,
    close() {
      closed = true;
      readyResolve();
      closing ??= watcher.close();
      return closing;
    },
  };
}
