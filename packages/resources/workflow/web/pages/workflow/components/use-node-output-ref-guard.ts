import type { Node } from "@xyflow/react";
import { useCallback, useRef, useState } from "react";
import { clearOutputRefs, countOutputRefs, renameOutputRefs } from "./node-output-refs-model";

/**
 * 输出字段改名 / 删除的下游引用确认（编排层，§3.5）。
 *
 * custom 工具节点的 outputs 由用户手填，下游节点的 inputs 里会引用
 * `nodes.<本节点 id>.output.<字段>`。改名或删除前要先数出被引用几处，有引用就弹确认框，
 * 用户点「确认」才把下游引用一起改掉、「取消」则整个操作作废——而 `OutputsEditor` 的两个回调
 * 需要的是**同步返回的 Promise<boolean>**（它的 key 输入在 blur 时等待这个结果决定是否回退本地状态），
 * 所以这里用「resolver 存 ref + 弹窗状态」把「弹窗」翻译成一个可 await 的布尔值。
 *
 * 纯函数（数引用 / 改写 / 置删除位）在 `node-output-refs-model.ts`；两个确认弹窗在
 * `node-output-ref-dialogs.tsx`；本文件只负责把两边接起来，不持有任何渲染。
 */
export interface OutputRenameDialogState {
  oldKey: string;
  newKey: string;
  affectedCount: number;
}

export interface OutputDeleteDialogState {
  key: string;
  affectedCount: number;
}

export function useNodeOutputRefGuard({
  nodes,
  nodeId,
  setNodes,
}: {
  /** 全部节点：下游引用的扫描范围 */
  nodes: Node[];
  /** 当前编辑的节点 id：引用表达式的中间段 */
  nodeId: string;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
}) {
  // 弹窗的「确认 / 取消」要能唤醒等待中的 Promise；resolver 存在 ref 里，不参与渲染。
  const renameResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [renameDialog, setRenameDialog] = useState<OutputRenameDialogState | null>(null);

  const deleteResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<OutputDeleteDialogState | null>(null);

  /** 处理输出字段删除：扫描下游引用，有引用时弹确认框 */
  const handleOutputDelete = useCallback(
    async (key: string): Promise<boolean> => {
      const affectedCount = countOutputRefs(nodes, nodeId, key);
      if (affectedCount === 0) return true;
      return new Promise<boolean>((resolve) => {
        deleteResolveRef.current = resolve;
        setDeleteDialog({ key, affectedCount });
      });
    },
    [nodes, nodeId],
  );

  /** 确认删除：清除下游引用中的该字段 */
  const confirmDeleteOutput = useCallback(() => {
    const dialog = deleteDialog;
    if (!dialog) return;
    setNodes((nds) => clearOutputRefs(nds, nodeId, dialog.key));
    deleteResolveRef.current?.(true);
    deleteResolveRef.current = null;
    setDeleteDialog(null);
  }, [deleteDialog, nodeId, setNodes]);

  const cancelDeleteOutput = useCallback(() => {
    deleteResolveRef.current?.(false);
    deleteResolveRef.current = null;
    setDeleteDialog(null);
  }, []);

  /** 处理输出字段改名：扫描下游引用，有引用时弹确认框 */
  const handleOutputRename = useCallback(
    async (oldKey: string, newKey: string): Promise<boolean> => {
      const affectedCount = countOutputRefs(nodes, nodeId, oldKey);
      if (affectedCount === 0) return true; // 无下游引用，直接通过
      return new Promise<boolean>((resolve) => {
        renameResolveRef.current = resolve;
        setRenameDialog({ oldKey, newKey, affectedCount });
      });
    },
    [nodes, nodeId],
  );

  /** 确认改名：扫描并同步下游引用 */
  const confirmRename = useCallback(() => {
    const dialog = renameDialog;
    if (!dialog) return;
    setNodes((nds) => renameOutputRefs(nds, nodeId, dialog.oldKey, dialog.newKey));
    renameResolveRef.current?.(true);
    renameResolveRef.current = null;
    setRenameDialog(null);
  }, [renameDialog, nodeId, setNodes]);

  const cancelRename = useCallback(() => {
    renameResolveRef.current?.(false);
    renameResolveRef.current = null;
    setRenameDialog(null);
  }, []);

  return {
    handleOutputRename,
    handleOutputDelete,
    renameDialog,
    deleteDialog,
    confirmRename,
    cancelRename,
    confirmDeleteOutput,
    cancelDeleteOutput,
  };
}
