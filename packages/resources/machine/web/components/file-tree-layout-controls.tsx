import { Button } from "@fenix/ui-components/ui/button";
import { PanelLeft, PanelLeftDashed, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { MACHINE_NS } from "../i18n/namespace";
import type { FileTreeLayoutMode } from "../lib/file-tree-layout";

/** 与文件树面板标题栏同尺寸（26px 方块、14px 图标）：本控件嵌在同一行里，不能比邻居大。 */
const CONTROL_CLASS = "size-6.5 text-text-muted hover:bg-surface-2 hover:text-text-primary";

interface FileTreeLayoutControlsProps {
  mode: FileTreeLayoutMode;
  /** 切换 浮动 / 固定。持久化归调用方（`useFileTreeLayout`），本组件只发意图。 */
  onToggleMode: () => void;
  /** 浮动模式下关闭浮层；固定模式不传——树是布局的一列，没有「关闭」一说。 */
  onCloseOverlay?: () => void;
}

/**
 * 文件树布局控件（浮动 ↔ 固定，以及浮动模式下的关闭）：由 `useFileTreeLayout` 的宿主经
 * `FileTreeTab` → `FileTreeView` 的 `headerActions` 槽渲染到树的面板标题栏里。
 *
 * 文案取本包命名空间（键的最终所在地 = 包的 owner）；按钮走组件库的 `Button`（真身是原生 `<button>`，
 * 可 Tab 聚焦、Enter/Space 触发），图标纯装饰并 `aria-hidden`，语义由 `aria-label` + `title` 承担。
 */
export function FileTreeLayoutControls({ mode, onToggleMode, onCloseOverlay }: FileTreeLayoutControlsProps) {
  const { t } = useTranslation(MACHINE_NS);
  const isFloating = mode === "floating";
  // 两条文案写成各自字面量的 `t()` 调用（而不是拼 key 变量）：本包字典完整性用例按字面量扫消费点，
  // 动态键会被判成死键（`web/__tests__/machine-i18n.test.ts`）。
  const toggleLabel = isFloating ? t("fileTree.layout.dock") : t("fileTree.layout.float");
  const closeLabel = t("fileTree.layout.close");

  return (
    <>
      <Button
        variant="ghost"
        size="icon-xs"
        className={CONTROL_CLASS}
        onClick={onToggleMode}
        title={toggleLabel}
        aria-label={toggleLabel}
      >
        {isFloating ? (
          <PanelLeftDashed className="size-3.5" aria-hidden />
        ) : (
          <PanelLeft className="size-3.5" aria-hidden />
        )}
      </Button>
      {onCloseOverlay && (
        <Button
          variant="ghost"
          size="icon-xs"
          className={CONTROL_CLASS}
          onClick={onCloseOverlay}
          title={closeLabel}
          aria-label={closeLabel}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      )}
    </>
  );
}
