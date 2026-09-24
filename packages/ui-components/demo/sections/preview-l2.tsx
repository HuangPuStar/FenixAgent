import { FileViewerPreview } from "@fenix/ui-components";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * Preview L2 分区：预览器 —— 文件内容渲染与渲染插件。
 *
 * 这一层是预览器本体：源文件怎么取回、文案用哪种语言，全部由调用方注入 ——
 * buildPreviewUrl 决定 URL、fetchPreview 决定取数方式（生产宿主注入 `apps/web/src/api/fs.ts` 的
 * buildPreviewSourceUrl / readPreviewSource），locale / messages 覆盖内置的简体中文文案，
 * 组件自身不关心路径从哪来、也不直连后端。demo 没有后端，两个示例都用 data: URL 顶掉宿主的文件代理路由
 * `/web/environments/<envId>/fs/<path>?preview=true`。
 *
 * 已知限制：不传 buildPreviewUrl 时走默认构建器，而它上面这条宿主路由是硬编码的，包内不定义该路由；
 * 不使用该约定的宿主必须自己注入。`fetchPreview` 没有默认值（包内刻意不留全局 `fetch` 兜底，§5.8），
 * 因此 demo 也必须显式给一个。非文本格式不由本层控制：pdf 走包内 native-pdf-plugin（浏览器原生
 * 渲染），docx / xlsx 等走官方 officePlugin，两者都会按文件类型自行决定是否以 Blob 取回原始字节。
 *
 * 示例数据是模块级静态常量，零网络、零路由；两个示例只差一个 URL 构建器与文件路径。
 */

/**
 * demo 的取数函数：拿全局 `fetch` 读 data: URL（本层示例不触网）。
 *
 * 生产宿主不这么写——那会让组件直连后端并自行拼 URL（§5.8），所以宿主注入的是域模块里的取数原语。
 */
const demoFetchPreview = (url: string, init?: RequestInit) => fetch(url, init);

/** 演示用文本内容：data: URL 不触网，也不依赖宿主路由。 */
const PREVIEW_SAMPLE = [
  "Fenix UI Components",
  "",
  "FileViewerPreview 的源文件由宿主注入的 buildPreviewUrl 提供，",
  "demo 用 data: URL 顶替 /web/environments/<envId>/fs/<path> 这条宿主路由。",
].join("\n");

/** 演示用 HTML 内容：交给包内 html-plugin（sandbox iframe）渲染实际页面效果。 */
const PREVIEW_HTML_SAMPLE = [
  "<!doctype html>",
  '<html lang="en">',
  '<head><meta charset="utf-8" /><title>html-plugin</title></head>',
  '<body style="font-family: system-ui; padding: 24px">',
  "  <h1>html-plugin</h1>",
  "  <p>HTML 由包内插件在 sandbox iframe 中渲染，不赋予 allow-same-origin。</p>",
  "</body>",
  "</html>",
].join("\n");

/** 演示用文本 URL 构建器：忽略环境与路径，直接返回内联文本的 data: URL。 */
function buildDemoTextPreviewUrl(_envId: string, _filePath: string): string {
  return `data:text/plain;charset=utf-8,${encodeURIComponent(PREVIEW_SAMPLE)}`;
}

/** 演示用 HTML URL 构建器：同样内联，交给 html-plugin 渲染。 */
function buildDemoHtmlPreviewUrl(_envId: string, _filePath: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(PREVIEW_HTML_SAMPLE)}`;
}

export function PreviewL2Section() {
  const { t } = useTranslation(DEMO_NS);

  return (
    <section>
      <h1 data-slot="demo-section-title" className="mb-6 text-[24px] font-semibold">
        {t("sections.previewL2")}
      </h1>
      <p className="mt-3 text-text-muted text-[12px]">{t("sectionHints.previewL2")}</p>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          FileViewerPreview — text
        </h2>
        <p className="mt-3 text-text-muted text-[12px]">
          预览器本体：buildPreviewUrl 注入源文件的取回方式（此处为 data: URL），locale / messages
          可覆盖内置的简体中文文案 —— 下面的示例显式传了 locale="en-US" 与部分 messages。
        </p>
        <div className="h-[320px] overflow-hidden rounded-md border border-border">
          <FileViewerPreview
            buildPreviewUrl={buildDemoTextPreviewUrl}
            fetchPreview={demoFetchPreview}
            envId="demo"
            filePath="demo/notes.txt"
            locale="en-US"
            messages={{ file: "File" }}
          />
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          <code>notes.txt</code> 属于文本类，组件会先把 data: URL 取回成 Blob 再交给预览器，
          以保证元数据里显示的是原始字节数；这一步之外没有任何网络请求。不传 <code>locale</code> / <code>messages</code>{" "}
          时预览器用内置简体中文。
        </p>
      </div>

      <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
        <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
          FileViewerPreview — html (html-plugin)
        </h2>
        <p className="mt-3 text-text-muted text-[12px]">
          渲染插件示例：<code>.html</code> 由包内 <code>html-plugin</code> 接管， 在 sandbox iframe
          中渲染页面效果（不赋予 allow-scripts 之外的权限），并提供「渲染预览 / 源码」切换； 没有该插件时 HTML 会被
          textPlugin 当纯文本展示。
        </p>
        <div className="h-[320px] overflow-hidden rounded-md border border-border">
          <FileViewerPreview
            buildPreviewUrl={buildDemoHtmlPreviewUrl}
            fetchPreview={demoFetchPreview}
            envId="demo"
            filePath="demo/report.html"
          />
        </div>
        <p className="mt-3 text-text-muted text-[12px]">
          HTML 需要保留 URL 给 iframe 使用，因此不像文本类那样转成 Blob；插件标签文案是硬编码中文，
          刻意不消费宿主字典（见包内 <code>html-plugin</code> 注释）。本示例的文件路径决定扩展名与 MIME， 换掉{" "}
          <code>filePath</code> 就会落到别的插件上。
        </p>
      </div>
    </section>
  );
}
