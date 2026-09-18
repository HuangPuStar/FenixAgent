import { FileViewerPreview, PreviewTab } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * 工作台分区：PreviewTab / FileViewerPreview。
 *
 * 这两个组件都带宿主路由约定，demo 用注入的方式替掉：FileViewerPreview 按 buildPreviewUrl 取回源文件，
 * demo 用 data: URL 顶掉宿主的文件代理路由 `/web/environments/<envId>/fs/<path>`；PreviewTab 只做
 * 空态 / 加载态 / 挂载预览器三种分支，无需取数。
 *
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 */

/** FileViewerPreview 的演示内容：data: URL 不触网，也不依赖宿主路由。 */
const PREVIEW_SAMPLE = [
  "Fenix UI Components",
  "",
  "FileViewerPreview 的源文件由宿主注入的 buildPreviewUrl 提供，",
  "demo 用 data: URL 顶替 /web/environments/<envId>/fs/<path> 这条宿主路由。",
].join("\n");

/** 演示用 URL 构建器：忽略环境与路径，直接返回内联文本的 data: URL。 */
function buildDemoPreviewUrl(_envId: string, _filePath: string): string {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(PREVIEW_SAMPLE)}`;
}

export function WorkspaceSection() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.workspace")}</h1>

      <div className="demo-example">
        <h2 className="demo-example-title">PreviewTab</h2>
        <p className="demo-hint">
          宿主 tab 的占位容器：无选中文件时给空态，有文件但缺环境上下文时给加载态， 两者齐备才挂载 FileViewerPreview。
        </p>
        <div className="demo-row" style={{ alignItems: "stretch" }}>
          <div className="flex-1 overflow-hidden rounded-md border border-border" style={{ height: 180 }}>
            <PreviewTab envId={null} filePath={null} />
          </div>
          <div className="flex-1 overflow-hidden rounded-md border border-border" style={{ height: 180 }}>
            <PreviewTab envId={null} filePath="user/notes.md" />
          </div>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">FileViewerPreview</h2>
        <p className="demo-hint">
          预览器本体：buildPreviewUrl 注入源文件的取回方式（此处为 data: URL），locale / messages
          可覆盖内置的简体中文文案 —— 下面的示例显式传了 locale="en-US" 与部分 messages。
        </p>
        <div className="overflow-hidden rounded-md border border-border" style={{ height: 320 }}>
          <FileViewerPreview
            buildPreviewUrl={buildDemoPreviewUrl}
            envId="demo"
            filePath="demo/notes.txt"
            locale="en-US"
            messages={{ file: "File" }}
          />
        </div>
      </div>
    </section>
  );
}
