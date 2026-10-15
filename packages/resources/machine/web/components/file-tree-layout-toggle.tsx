import { Button } from "@fenix/ui-components/ui/button";
import { PanelLeft, PanelLeftDashed } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MACHINE_NS } from "../i18n/namespace";
import type { FileTreeLayoutMode } from "../lib/file-tree-layout";

/** 与文件树面板标题栏同尺寸（26px 方块、14px 图标）：本控件嵌在同一行里，不能比邻居大。 */
const CONTROL_CLASS = "size-6.5 text-text-muted hover:bg-surface-2 hover:text-text-primary";

interface FileTreeLayoutToggleProps {
  mode: FileTreeLayoutMode;
  /** 切换 浮动 / 固定。持久化与「切模式后保持可见」归调用方（`useFileTreeLayout` + 工作区）。 */
  onToggleMode: () => void;
}

/**
 * 文件树布局切换控件（浮动 ↔ 固定）：由工作区经 `FileTreeTab` → `FileTreeView` 的 `headerActions` 槽
 * 渲染到树的面板标题栏里。
 *
 * 只有「切模式」这一个动作：浮动模式下树的显隐由预览区左缘的常驻切换按钮负责
 * （`file-tree-workbench.tsx`），这里不再有关闭入口——两个入口并列会让同一状态有两种操作路径。
 *
 * 文案取本包命名空间（键的最终所在地 = 包的 owner）；按钮走组件库的 `Button`（真身是原生 `<button>`，
 * 可 Tab 聚焦、Enter/Space 触发），图标纯装饰并 `aria-hidden`，语义由 `aria-label` + `title` 承担。
 */
export function FileTreeLayoutToggle({ mode, onToggleMode }: FileTreeLayoutToggleProps) {
  const { t } = useTranslation(MACHINE_NS);
  const isFloating = mode === "floating";
  // 两条文案写成各自字面量的 `t()` 调用（而不是拼 key 变量）：本包字典完整性用例按字面量扫消费点，
  // 动态键会被判成死键（`web/__tests__/machine-i18n.test.ts`）。
  const label = isFloating ? t("fileTree.layout.dock") : t("fileTree.layout.float");

  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={CONTROL_CLASS}
      onClick={onToggleMode}
      title={label}
      aria-label={label}
    >
      {isFloating ? (
        <PanelLeftDashed className="size-3.5" aria-hidden />
      ) : (
        <PanelLeft className="size-3.5" aria-hidden />
      )}
    </Button>
  );
}
