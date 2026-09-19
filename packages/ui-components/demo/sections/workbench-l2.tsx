import { WorkbenchPanel } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Workbench L2 分区：工作台面板表面。
 *
 * WorkbenchPanel 只给左侧索引 + 右侧内容一个共享表面，不含任何布局假设：
 * 圆角、背景与投影由它提供，内部的列宽、间距与滚动仍由调用方在 children 与 className 里决定。
 * 因此示例里的两栏只是静态文本，不涉及任何接口调用与业务语义。
 *
 * 与 Workbench L1 的分工：L1 是带滚动边界的主从骨架，L2 是更底层、可自由组合的表面。
 *
 * 导出名被 demo 外壳（demo/App.tsx）按分区装配引用，新增示例时保持导出名与签名不变。
 */

export function WorkbenchL2Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.workbenchL2")}</h1>
      <p className="demo-hint">{t("sectionHints.workbenchL2")}</p>

      <div className="demo-example">
        <h2 className="demo-example-title">WorkbenchPanel</h2>
        <WorkbenchPanel className="flex gap-4 p-4">
          <div className="w-[180px] shrink-0 rounded-md bg-surface-2 p-3 text-sm text-text-muted">Index column</div>
          <div className="min-w-0 flex-1 rounded-md bg-surface-2 p-3 text-sm text-text-muted">
            Detail column — WorkbenchPanel 只给左侧索引 + 右侧内容提供一个共享表面，不含任何布局假设。
          </div>
        </WorkbenchPanel>
      </div>
    </section>
  );
}
