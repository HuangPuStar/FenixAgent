/**
 * Agent 侧边栏树的破坏性操作确认弹窗。
 *
 * 从 `AgentSidebarTree.tsx` 拆出的渲染模块（§4.7 文件规模）：两个 `AlertDialog` 只在容器里挂载，
 * 自身不持有状态、不发请求——打开态、目标节点、选中集合与确认回调都由容器经 `useAgentSidebarTree`
 * 提供。JSX 与拆分前逐字一致：文案、className、禁用条件与确认语义均未改动。
 */
import { getAgentDisplayName } from "@fenix/agent-config/web/lib/agent-resource-access";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fenix/ui-components/ui/alert-dialog";
import { Checkbox } from "@fenix/ui-components/ui/checkbox";
import { Loader2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import type { AgentConfigItem, AgentTreeNode } from "./agent-sidebar-tree-model";
import { getRunningInstances } from "./agent-sidebar-tree-model";

interface AgentSidebarRestartDialogProps {
  /** 弹窗打开态，由容器持有。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 批量重启的目标 agent；为空时只渲染标题与页脚，实例勾选区整块省略。 */
  restartTargetNode: AgentTreeNode | null;
  selectedRestartInstances: Set<string>;
  setSelectedRestartInstances: Dispatch<SetStateAction<Set<string>>>;
  /** 确认重启：逐个重启选中实例（编排在 `useAgentSidebarTree`）。 */
  onConfirm: () => void;
}

/** 多实例重启选择弹窗：勾选该 agent 下要重启的实例。 */
export function AgentSidebarRestartDialog({
  open,
  onOpenChange,
  restartTargetNode,
  selectedRestartInstances,
  setSelectedRestartInstances,
  onConfirm,
}: AgentSidebarRestartDialogProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("restartTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("restartDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        {restartTargetNode && (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            <label className="flex items-center gap-2 px-2 py-1 text-sm font-medium">
              <Checkbox
                checked={
                  getRunningInstances(restartTargetNode).length > 0 &&
                  getRunningInstances(restartTargetNode).every((inst) => selectedRestartInstances.has(inst.instanceUid))
                }
                onCheckedChange={(checked) => {
                  if (checked) {
                    setSelectedRestartInstances(
                      new Set(getRunningInstances(restartTargetNode).map((i) => i.instanceUid)),
                    );
                  } else {
                    setSelectedRestartInstances(new Set());
                  }
                }}
              />
              {t("selectAll")}
            </label>
            {getRunningInstances(restartTargetNode).map((inst) => (
              <label key={inst.instanceUid} className="flex items-center gap-2 px-2 py-1 text-sm">
                <Checkbox
                  checked={selectedRestartInstances.has(inst.instanceUid)}
                  onCheckedChange={(checked) => {
                    setSelectedRestartInstances((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(inst.instanceUid);
                      else next.delete(inst.instanceUid);
                      return next;
                    });
                  }}
                />
                {inst.name}
              </label>
            ))}
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("restartLater")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={selectedRestartInstances.size === 0}>
            {t("restartConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface AgentSidebarDeleteDialogProps {
  /** 待删除的 agent；为空表示弹窗关闭。 */
  deleteTarget: AgentConfigItem | null;
  onOpenChange: (open: boolean) => void;
  /** 删除请求进行中：两个动作按钮同时禁用。 */
  deleting: boolean;
  /** 确认删除（编排在 `useAgentSidebarTree`，成功后由它关闭弹窗）。 */
  onConfirm: (agent: AgentConfigItem) => void;
}

/** 删除智能体确认弹窗。 */
export function AgentSidebarDeleteDialog({
  deleteTarget,
  onOpenChange,
  deleting,
  onConfirm,
}: AgentSidebarDeleteDialogProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);

  return (
    <AlertDialog open={deleteTarget !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteAgent")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteAgentConfirm", { name: deleteTarget ? getAgentDisplayName(deleteTarget) : "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            disabled={deleting}
            onClick={() => deleteTarget && onConfirm(deleteTarget)}
            className="bg-red-600 hover:bg-red-700"
          >
            {deleting ? <Loader2 className="w-4 h-4 animate-spin" /> : t("deleteAgent")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
