import type { PreviewFetch } from "@fenix/ui-components";
import { PreviewTab } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Preview L1 分区：预览容器 —— 空态、加载态与内容切换。
 *
 * PreviewTab 是宿主 tab 的占位容器：没有选中文件时给空态文案，有文件但缺环境上下文（envId）时给加载态，
 * 两者齐备才挂载 FileViewerPreview。`fetchPreview` 是必填契约（包内不留全局 `fetch` 兜底，见
 * `PreviewFetch`），`buildPreviewUrl` / `messages` / `locale` 仍可自由注入——需要这些定制时直接用预览器
 * （那是 Preview L2 的主题）。
 *
 * 因此本层只演示前两种分支：两个示例都不满足挂载条件（无 envId / 无 filePath），取数函数不会被调用；
 * 内容态的源文件 URL 与取数见 Preview L2。组件自身不取数，envId / filePath 全部由调用方
 * （宿主 tab 的选中态）注入，示例里是写死的静态值。
 */

/** 本层的两个示例都不会挂到预览器上，因此这个取数函数不会被调用（真实取数见 Preview L2）。 */
const neverCalledFetchPreview: PreviewFetch = () => {
  throw new Error("PreviewTab 未挂载预览器时不应取数");
};

export function PreviewL1Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.previewL1")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.previewL1")}</p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          PreviewTab
        </h2>
        <p className="mt-3 text-text-muted text-[12px]">
          宿主 tab 的占位容器：无选中文件时给空态，有文件但缺环境上下文时给加载态， 两者齐备才挂载 FileViewerPreview。
        </p>
        {/* 原先用内联 style 覆盖 demo-row 的 align-items：迁成工具类后直接写 items-stretch。 */}
        <div className="flex flex-wrap items-stretch gap-3">
          <div className="flex flex-col gap-1.5 flex-1">
            <p className="mt-3 text-text-muted text-[12px]">
              <code>envId=null</code> · <code>filePath=null</code> → 空态
            </p>
            <div className="h-[180px] overflow-hidden rounded-md border border-border">
              <PreviewTab envId={null} filePath={null} fetchPreview={neverCalledFetchPreview} />
            </div>
          </div>
          <div className="flex flex-col gap-1.5 flex-1">
            <p className="mt-3 text-text-muted text-[12px]">
              <code>envId=null</code> · <code>filePath="user/notes.md"</code> → 加载态
            </p>
            <div className="h-[180px] overflow-hidden rounded-md border border-border">
              <PreviewTab envId={null} filePath="user/notes.md" fetchPreview={neverCalledFetchPreview} />
            </div>
          </div>
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          加载态里的 spinner 是在等宿主补齐环境上下文（拿到 envId 后才会去取文件），因此会一直转下去； 等两个 prop
          齐备时 PreviewTab 会以 <code>key=filePath</code> 重建 FileViewerPreview ——
          切换文件不残留上一个文件的缩放与错误状态。内容态见 Preview L2。
        </p>
      </div>
    </section>
  );
}
