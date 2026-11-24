import {
  findFileNode,
  getRootFileTreePaths,
  type ParsedFileNode,
} from "@fenix/ui-components/components/file-tree-model";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { fsApi } from "../api/fs";
import { MACHINE_NS } from "../i18n/namespace";
import { getFileOperationErrorMessage } from "../lib/file-operation-errors";
import {
  planWorkspaceFileMoves,
  type WorkspaceFilesChange,
  type WorkspaceMoveFailure,
} from "../lib/workspace-file-operations";
import { type FileMutationLock, type FileMutationTask, useFileMutationLock } from "./use-file-mutation-lock";

interface FileTreeOperationsOptions {
  envId: string | null;
  enabled: boolean;
  mutationLock?: FileMutationLock;
  getTree: () => ParsedFileNode[];
  onChanged: (change: WorkspaceFilesChange) => void;
  onSelectionChange: (paths: string[]) => void;
  refreshTree: () => void;
  beforeMutation?: (paths: readonly string[], kind: "move" | "delete") => Promise<boolean>;
}

type OperationTask = FileMutationTask;

interface OperationFailure {
  path: string;
  error: string;
}

/** 文件写操作共用在途锁；只发布成功路径，过期环境的批次不再继续。 */
export function useFileTreeOperations(options: FileTreeOperationsOptions) {
  const { t } = useTranslation(MACHINE_NS);
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const localLock = useFileMutationLock(options.envId);
  const mutationLock = options.mutationLock ?? localLock;
  const [kind, setKind] = useState<"delete" | "write" | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ paths: string[]; name: string } | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 环境切换必须清空确认态，写请求取消由共享锁负责。
  useEffect(() => {
    setKind(null);
    setDeleteConfirm(null);
  }, [options.envId]);

  const current = (task: OperationTask) => mutationLock.isCurrent(task) && optionsRef.current.envId === task.envId;

  async function run(
    operationKind: "delete" | "write",
    fallback: string,
    operation: (task: OperationTask) => Promise<boolean>,
    guardPaths?: readonly string[],
  ): Promise<boolean> {
    const { envId, enabled } = optionsRef.current;
    if (!envId || !enabled) return false;
    const task = mutationLock.acquire();
    if (!task) return false;
    setKind(operationKind);
    try {
      const beforeMutation = optionsRef.current.beforeMutation;
      if (
        guardPaths &&
        beforeMutation &&
        !(await beforeMutation(guardPaths, operationKind === "delete" ? "delete" : "move"))
      )
        return false;
      if (!current(task)) return false;
      return await operation(task);
    } catch (error) {
      if (current(task)) {
        console.error("Workspace file operation failed:", error);
        toast.error(getFileOperationErrorMessage(error, t, fallback));
        optionsRef.current.refreshTree();
      }
      return false;
    } finally {
      if (mutationLock.isCurrent(task)) {
        setKind(null);
      }
      mutationLock.release(task);
    }
  }

  function complete(task: OperationTask, change: WorkspaceFilesChange, failed: OperationFailure[], message?: string) {
    if (!current(task)) return false;
    const callbacks = optionsRef.current;
    callbacks.onSelectionChange(
      failed.length ? failed.map((item) => item.path) : change.moved.map((item) => item.newPath),
    );
    callbacks.refreshTree();
    if (failed.length) {
      toast.error(
        t("fileTree.operationPartialFailed", {
          details: failed.map((item) => `${item.path}: ${item.error}`).join("; "),
        }),
      );
    } else if (message) {
      toast.success(message);
    }
    return failed.length === 0;
  }

  function requestDelete(paths: string[]) {
    if (mutationLock.isBusy() || !optionsRef.current.enabled) return;
    const roots = getRootFileTreePaths(paths).filter(
      (path) => path !== "user" && findFileNode(optionsRef.current.getTree(), path),
    );
    if (roots.length) setDeleteConfirm({ paths: roots, name: roots.join("、") });
  }

  async function confirmDelete(): Promise<boolean> {
    if (!deleteConfirm) return false;
    const paths = [...deleteConfirm.paths];
    return run(
      "delete",
      t("fileTree.contextMenu.delete"),
      async (task) => {
        const result = await unwrap(fsApi.batchDelete(task.envId, paths, task.controller.signal));
        if (!current(task)) return false;
        const failed = result.failed;
        if (result.deleted.length) optionsRef.current.onChanged({ moved: [], deleted: result.deleted });
        setDeleteConfirm(
          failed.length
            ? { paths: failed.map((item) => item.path), name: failed.map((item) => item.path).join("、") }
            : null,
        );
        return complete(task, { moved: [], deleted: result.deleted }, failed, t("fileTree.deleteSucceeded"));
      },
      paths,
    );
  }

  function planFailure(failure: WorkspaceMoveFailure): OperationFailure {
    const messages = {
      conflict: t("fileTree.pathConflict"),
      descendant: t("fileTree.moveIntoSelf"),
      "invalid-target": t("fileTree.moveInvalidTarget"),
      "protected-root": t("fileTree.moveProtectedRoot"),
      "missing-source": t("fileTree.moveMissingSource"),
    };
    return { path: failure.path, error: messages[failure.reason] };
  }

  async function moveToDirectory(paths: string[], targetDir: string): Promise<boolean> {
    return run(
      "write",
      t("fileTree.moveFailed"),
      async (task) => {
        const plan = planWorkspaceFileMoves(paths, targetDir, optionsRef.current.getTree());
        if (!plan.moves.length && !plan.failed.length) return true;
        const failed = plan.failed.map(planFailure);
        const moved: WorkspaceFilesChange["moved"] = [];
        for (const move of plan.moves) {
          if (!current(task)) return false;
          try {
            await unwrap(fsApi.rename(task.envId, move.oldPath, move.newPath, task.controller.signal));
            if (!current(task)) return false;
            moved.push(move);
            // 预览归父面板持有；逐项发布已确认结果，避免切换面板卸载树时丢失成功路径。
            optionsRef.current.onChanged({ moved: [move], deleted: [] });
          } catch (error) {
            if (!current(task)) return false;
            console.error("Workspace file move failed:", { path: move.oldPath, error });
            failed.push({
              path: move.oldPath,
              error: getFileOperationErrorMessage(error, t, t("fileTree.moveFailed")),
            });
          }
        }
        return complete(task, { moved, deleted: [] }, failed, t("fileTree.moveSucceeded"));
      },
      paths,
    );
  }

  async function renamePath(oldPath: string, newPath: string): Promise<boolean> {
    if (oldPath === newPath) return true;
    return run(
      "write",
      t("fileTree.renameFailed"),
      async (task) => {
        await unwrap(fsApi.rename(task.envId, oldPath, newPath, task.controller.signal));
        if (!current(task)) return false;
        optionsRef.current.onChanged({ moved: [{ oldPath, newPath }], deleted: [] });
        return complete(task, { moved: [{ oldPath, newPath }], deleted: [] }, [], t("fileTree.moveSucceeded"));
      },
      [oldPath],
    );
  }

  async function createPath(path: string, directory: boolean): Promise<boolean> {
    return run("write", directory ? t("fileTree.mkdirFailed") : t("fileTree.newFileFailed"), async (task) => {
      if (directory) await unwrap(fsApi.mkdir(task.envId, path, task.controller.signal));
      else await unwrap(fsApi.createFile(task.envId, path, task.controller.signal));
      if (!current(task)) return false;
      optionsRef.current.refreshTree();
      return true;
    });
  }

  return {
    busy: mutationLock.busy,
    deleting: kind === "delete",
    deleteConfirm,
    requestDelete,
    closeDelete: () => {
      if (!mutationLock.isBusy()) setDeleteConfirm(null);
    },
    confirmDelete,
    moveToDirectory,
    renamePath,
    createPath,
  };
}
