import { PreviewTab } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Preview L1 分区：预览容器 —— 空态、加载态与内容切换。
 *
 * PreviewTab 是宿主 tab 的占位容器：没有选中文件时给空态文案，有文件但缺环境上下文（envId）时给加载态，
 * 两者齐备才挂载 FileViewerPreview。它刻意不透传 buildPreviewUrl / messages / locale ——
 * 需要这些定制时直接用预览器（那是 Preview L2 的主题）。
 *
 * 因此本层只演示前两种分支：内容态会落到默认 URL 构建器，而默认构建器硬编码宿主的文件代理路由
 * `/web/environments/<envId>/fs/<path>?preview=true`，demo 里没有这条路由。组件自身不取数，
 * envId / filePath 全部由调用方（宿主 tab 的选中态）注入，示例里是写死的静态值。
 */

export function PreviewL1Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.previewL1")}</h1>
      <p className="demo-hint">{t("sectionHints.previewL1")}</p>

      <div className="demo-example">
        <h2 className="demo-example-title">PreviewTab</h2>
        <p className="demo-hint">
          宿主 tab 的占位容器：无选中文件时给空态，有文件但缺环境上下文时给加载态， 两者齐备才挂载 FileViewerPreview。
        </p>
        <div className="demo-row" style={{ alignItems: "stretch" }}>
          <div className="demo-field flex-1">
            <p className="demo-hint">
              <code>envId=null</code> · <code>filePath=null</code> → 空态
            </p>
            <div className="h-[180px] overflow-hidden rounded-md border border-border">
              <PreviewTab envId={null} filePath={null} />
            </div>
          </div>
          <div className="demo-field flex-1">
            <p className="demo-hint">
              <code>envId=null</code> · <code>filePath="user/notes.md"</code> → 加载态
            </p>
            <div className="h-[180px] overflow-hidden rounded-md border border-border">
              <PreviewTab envId={null} filePath="user/notes.md" />
            </div>
          </div>
        </div>
        <p className="demo-hint">
          加载态里的 spinner 是在等宿主补齐环境上下文（拿到 envId 后才会去取文件），因此会一直转下去； 等两个 prop
          齐备时 PreviewTab 会以 <code>key=filePath</code> 重建 FileViewerPreview ——
          切换文件不残留上一个文件的缩放与错误状态。内容态见 Preview L2。
        </p>
      </div>
    </section>
  );
}
