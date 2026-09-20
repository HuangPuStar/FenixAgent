import { AppHeader, AppPage, Button } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Base UI P1 分区：整体页面布局模板。
 *
 * 收录 AppPage / AppHeader 这两条页面级骨架：它们决定宿主整页的滚动边界与标题基线，
 * 本身不承载业务语义。工作台骨架已拆到 Workbench L1/L2。
 *
 * 这两个组件都是「容器」：布局与状态边界由组件提供，数据与异步流程由调用方注入。
 * 因此示例里的数据全部是本文件内的静态假数据，不涉及任何接口调用。
 *
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 */

export function BaseUiP1Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.baseUiP1")}</h1>
      <p className="demo-hint">{t("sectionHints.baseUiP1")}</p>

      <div className="demo-example">
        <h2 className="demo-example-title">AppPage / AppHeader</h2>
        <p className="demo-hint">
          AppPage 是页面级滚动边界（flex-1 + overflow-auto），因此示例给它一个确定高度的 flex 容器。
        </p>
        <div className="flex h-[320px] flex-col overflow-hidden rounded-lg border border-border">
          <AppPage>
            <AppHeader
              title="Workspace overview"
              subtitle="AppHeader 固定标题层级与操作区基线，AppPage 负责背景、留白与滚动。"
              actions={<Button size="sm">New agent</Button>}
            />
            <p className="mt-6 text-sm text-text-muted">
              Page body — content longer than the frame scrolls inside AppPage, not in the demo shell.
            </p>
          </AppPage>
        </div>
      </div>
    </section>
  );
}
