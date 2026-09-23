import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";

/**
 * 版本行的破坏性动作二次确认：三处原先各写一份（`WorkflowVersions` / `VersionPanel` /
 * `VersionIndicator`），除了文案来源不同，接线与判定完全一致——同一个 `{ type, version }` 状态形状、
 * 同一段 title / description 三元表达式、同一条「restore 才是 destructive」的变体规则。
 *
 * 抽出来主要是为了那条规则只有一个落点：三份副本已经漂移过一次——面板的 `onConfirm` 末尾自己补了
 * `setConfirmAction(null)`，另两处靠 `handleSetLatest` 在开头清、或靠 `onOpenChange` 在关闭时清。
 * 现在「确认后关闭」由本组件统一做，调用方只需处理动作本身。
 */

/** 待确认的动作：`null` 表示没有待确认项（`ConfirmDialog` 的 open 由它派生）。 */
export type VersionConfirmAction = { type: "setLatest" | "restore"; version: number } | null;

/**
 * 文案由调用方翻译后传入（同 `VersionRowLabels`）：三处读同一族 key 的只有 title，
 * description 已经分叉（面板与弹层恢复用 `editor.vi_restore_confirm`，版本页用 `versions.restore_confirm`），
 * 合并 key 等于替页面重指文案，超出收敛重复的范围。
 */
export interface VersionConfirmDialogLabels {
  /** 「设为 latest」确认框标题 */
  setLatestTitle: string;
  /** 「恢复到草稿」确认框标题 */
  restoreTitle: string;
  /** 「设为 latest」确认框正文（插值 version 后返回） */
  setLatestDescription: (version: number) => string;
  /** 「恢复到草稿」确认框正文（插值 version 后返回） */
  restoreDescription: (version: number) => string;
}

export interface VersionConfirmDialogProps {
  action: VersionConfirmAction;
  labels: VersionConfirmDialogLabels;
  /** 用户取消（Esc / 遮罩 / 取消按钮）时清空待确认动作 */
  onClose: () => void;
  /** 用户确认：动作已带 version，调用方只做请求与刷新 */
  onConfirm: (action: { type: "setLatest" | "restore"; version: number }) => void;
}

export function VersionConfirmDialog({ action, labels, onClose, onConfirm }: VersionConfirmDialogProps) {
  return (
    <ConfirmDialog
      open={action !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={action?.type === "restore" ? labels.restoreTitle : labels.setLatestTitle}
      description={
        action === null
          ? ""
          : action.type === "restore"
            ? labels.restoreDescription(action.version)
            : labels.setLatestDescription(action.version)
      }
      variant={action?.type === "restore" ? "destructive" : "default"}
      onConfirm={() => {
        if (!action) return;
        onConfirm(action);
        onClose();
      }}
    />
  );
}
