// web/src/pages/admin/components/RowDeleteButton.tsx
// 列表行/摘要行里的「删除」动作按钮（红描边、sm）。
//
// 2026-09-22 前端去重：四处逐字复制了同一个 `Button` —— `size="sm"` + `variant="outline"` +
// 同一串红描边类名 + `t("delete")`，只有 `onClick` 不同：
//   - ClusterPanel（删除 Cluster Pool）、PoolTree（删除资源池）
//   - ClusterServerRow（删除 Server）、InstanceRow（删除实例）
//
// 为什么仍是「红描边」而不是组件库的 `variant="destructive"`：它和同一动作组里的 detail / edit /
// rebuild 等 `outline` 按钮并排（行级、次要动作），换成实心红会单独拔高这一颗按钮的视觉权重；
// 组件库目前没有 `destructive-outline` 变体，且本轮不写 `packages/ui-components/**`。
// 类名因此在本包内收口，等库补齐该变体后只改这一处。

import { Button } from "@fenix/ui-components/ui/button";
import { useTranslation } from "react-i18next";

import { SANDBOX_NS } from "../../../../i18n/namespace";

export interface RowDeleteButtonProps {
  /** 触发删除确认（确认框由调用方持有）。 */
  onClick: () => void;
}

export function RowDeleteButton({ onClick }: RowDeleteButtonProps) {
  const { t } = useTranslation(SANDBOX_NS);
  return (
    <Button
      size="sm"
      variant="outline"
      className="border-red-200 bg-red-50 text-red-700 hover:bg-red-100"
      onClick={onClick}
    >
      {t("delete")}
    </Button>
  );
}
