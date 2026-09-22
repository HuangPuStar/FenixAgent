import { AgentMasterDetailHeader, AgentMasterDetailWorkspace } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Workbench L1 分区：主从工作台骨架。
 *
 * AgentMasterDetailWorkspace 决定宿主整页的主从布局与滚动边界：索引区、详情头部与详情底部固定，
 * 详情区独立滚动；索引、头部与底部的内容全部由调用方注入，组件本身不含业务语义。
 * 因此示例里给的都是本文件内的静态占位内容，不涉及任何接口调用。
 *
 * 与 Base UI P1 的分工：P1 只有页面级滚动边界与标题基线，工作台骨架属于业务域，落在本层。
 *
 * 导出名被 demo 外壳（demo/App.tsx）按分区装配引用，新增示例时保持导出名与签名不变。
 */

const DETAIL_SECTIONS = ["Overview", "Capabilities", "Settings"];

/** 详情区占位段落：内容足够多时才会触发详情区自身的滚动。 */
const DETAIL_BLOCKS = Array.from({ length: 12 }, (_, index) => `Content block ${index + 1}`);

export function WorkbenchL1Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.workbenchL1")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.workbenchL1")}</p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          MasterDetailWorkspace (agent-master-detail-workspace)
        </h2>
        <p className="mt-3 text-text-muted text-[12px]">
          该组件自带 `calc(100dvh - 210px)` 高度，用于宿主整页布局；示例按原样渲染，未做尺寸改写。
        </p>
        <AgentMasterDetailWorkspace
          index={
            <div className="flex flex-col gap-1 p-3">
              {DETAIL_SECTIONS.map((section) => (
                <div key={section} className="rounded-md px-3 py-2 text-sm text-text-muted">
                  {section}
                </div>
              ))}
            </div>
          }
          detailHeader={
            <AgentMasterDetailHeader>
              <div className="border-b border-border px-6 py-4 text-sm font-medium">Translator</div>
            </AgentMasterDetailHeader>
          }
          detailFooter={
            <div className="border-t border-border px-6 py-3 text-xs text-text-muted">detailFooter 区域</div>
          }
        >
          <div className="p-6 text-sm text-text-muted">
            <p>详情区独立滚动，索引区与头部/底部固定。</p>
            {DETAIL_BLOCKS.map((block) => (
              <p key={block} className="mt-3">
                {block}
              </p>
            ))}
          </div>
        </AgentMasterDetailWorkspace>
      </div>
    </section>
  );
}
