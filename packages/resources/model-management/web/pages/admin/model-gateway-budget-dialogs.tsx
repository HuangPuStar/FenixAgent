/**
 * 预算 Tab 的两个弹窗：批量 / 单个设置预算，以及重置已勾选用户的预算。
 *
 * §4.7 拆分（2026-09-23）：两者原先内联在预算 Tab 的筛选条与表格之间（`AdminModelGatewayPage.tsx` 中段），
 * 与表格 JSX 混在同一段。它们是纯展示件——开关、取值与提交动作都来自 `useModelGatewayBudgets`。
 *
 * 重置确认用的是库内 `ConfirmDialog`（「标题 + 说明 + 取消/确认 + loading」这套形态的唯一实现），
 * 本页原先手写过第二份，已在此前批次收敛（与同屏的密钥面板同形）。
 */
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Button } from "@fenix/ui-components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@fenix/ui-components/ui/dialog";
import { useTranslation } from "react-i18next";
import { MODELS_NS } from "../../i18n/namespace";
import { DIALOG_FIELD_CLASS } from "./model-gateway-shared";

/** 设置预算弹窗：`target` 同时充当开关（`null` 即关闭）与标题分支。 */
export function ModelGatewayBudgetDialog({
  target,
  amount,
  duration,
  selectedCount,
  submitting,
  onAmountChange,
  onDurationChange,
  onClose,
  onConfirm,
}: {
  /** `"batch"` 是批量设置；字符串是单个用户的 id；`null` 表示弹窗关闭。 */
  target: "batch" | string | null;
  amount: string;
  duration: string;
  selectedCount: number;
  submitting: boolean;
  onAmountChange: (amount: string) => void;
  onDurationChange: (duration: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(MODELS_NS);

  return (
    <Dialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t(target === "batch" ? "modelGateway.budgetsPage.batchTitle" : "modelGateway.budgetsPage.editTitle")}
          </DialogTitle>
          <DialogDescription>{t("modelGateway.budgetsPage.dialogHint", { count: selectedCount })}</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <input
            className={DIALOG_FIELD_CLASS}
            type="number"
            min="0"
            placeholder={t("modelGateway.amount")}
            value={amount}
            onChange={(event) => onAmountChange(event.target.value)}
          />
          <select
            className={DIALOG_FIELD_CLASS}
            value={duration}
            onChange={(event) => onDurationChange(event.target.value)}
          >
            <option value="once">{t("modelGateway.once")}</option>
            <option value="1d">1d</option>
            <option value="7d">7d</option>
            <option value="30d">30d</option>
          </select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("modelGateway.budgetsPage.cancel")}
          </Button>
          <Button disabled={amount === "" || submitting} onClick={onConfirm}>
            {t("modelGateway.budgetsPage.confirmSet")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 重置已勾选用户的预算：不可撤销，故走确认弹窗；`count` 是当前勾选数。 */
export function ModelGatewayResetBudgetDialog({
  open,
  count,
  resetting,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  count: number;
  resetting: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation(MODELS_NS);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      loading={resetting}
      title={t("modelGateway.budgetsPage.resetTitle")}
      description={t("modelGateway.budgetsPage.resetDescription", { count })}
      confirmLabel={t("modelGateway.budgetsPage.resetBudget")}
      cancelLabel={t("modelGateway.budgetsPage.cancel")}
      onConfirm={onConfirm}
    />
  );
}
