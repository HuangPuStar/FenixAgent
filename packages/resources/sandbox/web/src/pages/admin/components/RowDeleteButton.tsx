// web/src/pages/admin/components/RowDeleteButton.tsx
// 列表行/摘要行里的「删除」动作按钮（红描边、sm）。
//
// 2026-09-22 前端去重：四处逐字复制了同一个 `Button` —— `size="sm"` + `variant="outline"` +
// 同一串红描边类名 + `t("delete")`，只有 `onClick` 不同：
//   - ClusterPanel（删除 Cluster Pool）、PoolTree（删除资源池）
//   - ClusterServerRow（删除 Server）、InstanceRow（删除实例）
//
// 为什么仍是「红描边」而不是组件库的 `variant="destructive"`：它和同一动作组里的 detail / edit /
// rebuild 等 `outline` 按钮并排（行级、次要动作），换成实心红会单独拔高这一颗按钮的视觉权重。
// 类名因此在本包内收口。
//
// 2026-09-22 复核「要不要为它给组件库补 `destructive-outline` 变体」（当时记为「等库补齐」）：
// 全仓 grep 下来，**红描边形态只有本包**——另一处是 InstanceDetailDialog 的 clearOverride，配方相同；
// 其余包的红按钮要么是无描边的红字（`ghost` + `text-destructive`：mcp、task、skill、prod-view……），
// 要么是实心 `destructive`（memory、workflow、identity……），换上红描边都会改变视觉权重。按本仓
// 「抽象延迟到第二个真实用例」的口径，单包不为它进库，类名继续留在这一件里；哪天真有第二个包需要
// 红描边，再把这两处一起搬过去。

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
