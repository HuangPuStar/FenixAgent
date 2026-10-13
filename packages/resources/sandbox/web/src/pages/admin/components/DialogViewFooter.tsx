// web/src/pages/admin/components/DialogViewFooter.tsx
// 「查看态」对话框页脚：关闭 + 切到编辑。
//
// 2026-09-22 前端去重：InstanceDetailDialog 与 PoolDialog 都用「打开即查看、点编辑才可写」的
// 两态页脚（`editing ? … : …`），其中查看态分支逐字相同（描边「关闭」+ 主色「编辑」）。
//
// 只收口查看态：编辑态页脚的语义两边不同（实例详情要 resetForm，资源池走 cancelEdit 并额外受
// JSON 校验禁用），合并会把差异藏进参数里，反而更难读。

import { Button } from "@fenix/ui-components/ui/button";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";

export interface DialogViewFooterProps {
  /** 关闭对话框。 */
  onClose: () => void;
  /** 切到编辑态。 */
  onEdit: () => void;
}

export function DialogViewFooter({ onClose, onEdit }: DialogViewFooterProps) {
  const { t } = useTranslation(SANDBOX_NS);
  return (
    <>
      <Button variant="outline" onClick={onClose}>
        {t("close")}
      </Button>
      <Button onClick={onEdit}>{t("edit")}</Button>
    </>
  );
}
