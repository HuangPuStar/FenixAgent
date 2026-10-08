/**
 * Agent 侧栏树的破坏性操作确认弹窗。
 *
 * 随侧栏树从宿主 `apps/web/src/shell/AgentSidebarTreeDialogs.tsx` 迁入本包（2026-09-28）：弹窗只在
 * 容器里挂载，自身不持有状态、不发请求——打开态、目标节点、选中集合与确认回调都由容器经
 * `useAgentSidebarTree` 提供。重启弹窗含实例勾选区，保留手写 `AlertDialog`；删除弹窗用库里的
 * `ConfirmDialog`（见 `AgentSidebarDeleteDialog` 内注释）。
 *
 * 文案全部取自本包 `agents` 字典：重启的两条动作词条（`restartConfirm` / `restartLater`）与编辑器
 * 的重启提示共用同一句话（台账 D4 把键统一在本包，宿主侧只删不留）。
 */
import type { EnvironmentInstanceInfo } from "@fenix/agent-runtime/web/api/environments";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
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
import type { AgentInfo } from "@fenix/web-runtime/types/config";
import type { Dispatch, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { AGENTS_NS } from "../../i18n/namespace";
import { getAgentDisplayName } from "../../lib/agent-resource-access";

interface AgentSidebarRestartDialogProps {
  /** 弹窗打开态，由容器持有。 */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 批量重启的目标 agent；为空时只渲染标题与页脚，实例勾选区整块省略。 */
  restartInstances: readonly EnvironmentInstanceInfo[];
  selectedRestartInstances: Set<string>;
  setSelectedRestartInstances: Dispatch<SetStateAction<Set<string>>>;
  /** 确认重启：逐个重启选中实例（编排在 `useAgentSidebarTree`）。 */
  onConfirm: () => void;
}

/** 多实例重启选择弹窗：勾选该 agent 下要重启的实例。 */
export function AgentSidebarRestartDialog({
  open,
  onOpenChange,
  restartInstances,
  selectedRestartInstances,
  setSelectedRestartInstances,
  onConfirm,
}: AgentSidebarRestartDialogProps) {
  const { t } = useTranslation(AGENTS_NS);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("restartTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("restartDescription")}</AlertDialogDescription>
        </AlertDialogHeader>
        {restartInstances.length > 0 && (
          <div className="space-y-2 max-h-48 overflow-y-auto">
            <label className="flex items-center gap-2 px-2 py-1 text-sm font-medium">
              <Checkbox
                checked={
                  restartInstances.length > 0 &&
                  restartInstances.every((instance) => selectedRestartInstances.has(instance.instanceUid))
                }
                onCheckedChange={(checked) => {
                  if (checked) {
                    setSelectedRestartInstances(new Set(restartInstances.map((instance) => instance.instanceUid)));
                  } else {
                    setSelectedRestartInstances(new Set());
                  }
                }}
              />
              {t("selectAll")}
            </label>
            {restartInstances.map((instance) => (
              <label key={instance.instanceUid} className="flex items-center gap-2 px-2 py-1 text-sm">
                <Checkbox
                  checked={selectedRestartInstances.has(instance.instanceUid)}
                  onCheckedChange={(checked) => {
                    setSelectedRestartInstances((prev) => {
                      const next = new Set(prev);
                      if (checked) next.add(instance.instanceUid);
                      else next.delete(instance.instanceUid);
                      return next;
                    });
                  }}
                />
                {instance.name}
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
  deleteTarget: AgentInfo | null;
  onOpenChange: (open: boolean) => void;
  /** 删除请求进行中：两个动作按钮同时禁用。 */
  deleting: boolean;
  /** 确认删除（编排在 `useAgentSidebarTree`，成功后由它关闭弹窗）。 */
  onConfirm: (agent: AgentInfo) => void;
}

/** 删除智能体确认弹窗。 */
export function AgentSidebarDeleteDialog({
  deleteTarget,
  onOpenChange,
  deleting,
  onConfirm,
}: AgentSidebarDeleteDialogProps) {
  const { t } = useTranslation(AGENTS_NS);

  // 2026-09-22 前端去重：此前是手写 AlertDialog + 裸色号 `bg-red-600 hover:bg-red-700` 的确认按钮 +
  // `Loader2` 图标转圈，与库里的 `ConfirmDialog` 同构（仓库另有约 20 处在用它）。改用库组件后
  // 危险动作走 `variant="destructive"` 语义色，进行中态由库统一成「处理中…」文案（不再是图标转圈）。
  return (
    <ConfirmDialog
      open={deleteTarget !== null}
      onOpenChange={onOpenChange}
      title={t("deleteAgentTitle")}
      description={t("deleteAgentConfirm", { name: deleteTarget ? getAgentDisplayName(deleteTarget) : "" })}
      variant="destructive"
      confirmLabel={t("deleteAgentTitle")}
      cancelLabel={t("dialog.cancel")}
      loading={deleting}
      onConfirm={() => {
        if (deleteTarget) onConfirm(deleteTarget);
      }}
    />
  );
}
