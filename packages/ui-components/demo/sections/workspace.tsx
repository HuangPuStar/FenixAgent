import {
  CollapsibleSidePanel,
  CronEditor,
  FileViewerPreview,
  PreviewTab,
  SearchableSelect,
  SegmentedSwitcher,
  type SegmentedSwitcherOption,
  TagFilterInput,
} from "@fenix/ui-components";
import { LayoutGrid, List, Table2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { DEMO_NS } from "../i18n";

/**
 * 工作台分区：SearchableSelect / SegmentedSwitcher / TagFilterInput / CronEditor /
 * CollapsibleSidePanel / PreviewTab / FileViewerPreview。
 *
 * 这些组件都是受控且不自行取数的控件：状态与回调全部由调用方提供，因此示例里的状态都是本文件内的
 * useState，不涉及任何接口调用。唯一的例外是 FileViewerPreview —— 它按 buildPreviewUrl 取回源文件，
 * demo 用 data: URL 注入，避免依赖宿主的文件代理路由 `/web/environments/<envId>/fs/<path>`。
 *
 * 导出名被 demo/App.tsx 引用，新增示例时保持导出名与签名不变。
 */

/** 下拉控件的演示数据；用模块级常量避免重复渲染时重建列表。 */
const REGION_OPTIONS = [
  { value: "apac", label: "Asia Pacific" },
  { value: "emea", label: "Europe / Middle East / Africa" },
  { value: "amer", label: "Americas" },
];

/** 分段切换器的演示数据；label 与 ariaLabel 都是 props，组件不认识任何文案键。 */
const VIEW_OPTIONS: SegmentedSwitcherOption<"list" | "table" | "board">[] = [
  { value: "list", label: "List", icon: List },
  { value: "table", label: "Table", icon: Table2 },
  { value: "board", label: "Board", icon: LayoutGrid },
];

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
  const [region, setRegion] = useState("");
  const [keyword, setKeyword] = useState("");
  const [view, setView] = useState<"list" | "table" | "board">("list");
  const [tags, setTags] = useState<string[]>(["stable", "internal"]);
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [panelOpen, setPanelOpen] = useState(true);

  return (
    <section className="demo-section">
      <h1 className="demo-section-title">{t("sections.workspace")}</h1>

      <div className="demo-example">
        <h2 className="demo-example-title">SearchableSelect</h2>
        <p className="demo-hint">
          文案（allLabel / emptyLabel / searchPlaceholder）全部由 props 传入，组件本身零 i18n； 检索词通过
          onSearchChange 回传，调用方可据此做服务端过滤。
        </p>
        <div className="demo-row">
          <SearchableSelect
            allLabel="All regions"
            emptyLabel="No matching region"
            options={REGION_OPTIONS}
            searchPlaceholder="Search region..."
            value={region}
            onSearchChange={setKeyword}
            onValueChange={setRegion}
          />
          <span className="demo-hint">
            value: {region || "(all)"} / keyword: {keyword || "(empty)"}
          </span>
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">SegmentedSwitcher</h2>
        <p className="demo-hint">受控分段切换：当前项以 aria-pressed 标记，泛型由 options 的 value 联合类型推导。</p>
        <SegmentedSwitcher ariaLabel="Workspace view" options={VIEW_OPTIONS} value={view} onValueChange={setView} />
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">TagFilterInput</h2>
        <p className="demo-hint">
          Enter 或逗号提交标签，空输入按 Backspace 删除末尾标签；placeholder 与移除按钮文案默认取包内 tagInput.*
          字典，也可由 props 覆盖（此处保持默认）。
        </p>
        <TagFilterInput value={tags} onChange={setTags} />
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">CronEditor</h2>
        <p className="demo-hint">
          预设快选 + 自定义输入：点上排按钮切换预设，「自定义」清空后手动输入； 非法表达式在 400ms 防抖后显示
          cron.error.* 文案，下方描述由 describeCron 解析得出。
        </p>
        <div className="max-w-xl">
          <CronEditor value={cron} onChange={setCron} />
        </div>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">CollapsibleSidePanel</h2>
        <p className="demo-hint">
          children 是测量式渲染函数：容器把主区域实测高度回传，画布类子组件据此自绘（首帧高度为 1）； 侧栏折叠只作用于
          md 断点，点击中间分隔条上的箭头切换。
        </p>
        <div style={{ height: 240 }}>
          <CollapsibleSidePanel
            panelOpen={panelOpen}
            sidebar={<div className="p-3 text-xs text-text-muted">sidebar prop 渲染的侧栏内容。</div>}
            toggleLabel="Toggle side panel"
            onPanelOpenChange={setPanelOpen}
          >
            {(height) => (
              <div className="flex h-full items-center justify-center text-xs text-text-muted">
                children(height) 实测主区域高度：{height}px
              </div>
            )}
          </CollapsibleSidePanel>
        </div>
      </div>

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
