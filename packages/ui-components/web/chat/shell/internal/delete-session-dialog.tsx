import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../ui/alert-dialog";

/**
 * 会话删除的二次确认弹窗。
 *
 * 2026-09-22 库内去重：`chat/shell/ChatHeader.tsx` 与 `chat/shell/sidebar-session-list.tsx`
 * 此前各内联了一份逐字相同的 `AlertDialog`（标题 / 描述 / 取消 / 确认四段与 i18n 键、文案插值完全一致），
 * 收敛到此；两处只有「确认按钮的类名」「取消按钮是否显式回调」「确认回调是否 `void` 包装」三点非语义差异，
 * 已按下述口径归一（差异表见引入该组件的提交信息）：
 *
 * - 确认按钮类名取 ChatHeader 的较全写法（含 `dark:` 分支），侧栏那一份原本是 light-only。
 * - 取消按钮不再写显式回调：Radix 的 `Cancel` 关闭弹窗后经 `onOpenChange(false)` 回传，
 *   调用方在那个回调里清 `deleteTarget`，行为与原先的 `onClick` 一致。
 *
 * 本组件不进公共出口（`web/chat/shell/internal/` 下，不做深链导出）；`title` 缺省时插值为空串，
 * 与原先 `deleteTarget?.title ?? ""` 一致。
 */
export interface DeleteSessionDialogProps {
  open: boolean;
  /** 待删除会话的标题；缺省时标题插值为空串。 */
  title?: string;
  /** 关闭原因（含取消与遮罩/Esc 关闭）统一经此回传，调用方据此清空选中项。 */
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

export function DeleteSessionDialog({ open, title, onOpenChange, onConfirm }: DeleteSessionDialogProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("chat.components.acpMain.deleteSessionTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("chat.components.acpMain.deleteConfirm", { title: title ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("chat.components.acpMain.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-red-600 text-white hover:bg-red-700 dark:bg-red-500 dark:hover:bg-red-600"
            onClick={onConfirm}
          >
            {t("chat.components.acpMain.delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
