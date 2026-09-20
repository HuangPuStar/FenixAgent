import { Button, ThemeToggle } from "@fenix/ui-components";
import { type ComponentType, useState } from "react";
import { useTranslation } from "react-i18next";

import { changeDemoLanguage, DEMO_NS, type DemoLanguage, getDemoLanguage } from "./i18n";
import { AgentL1Section } from "./sections/agent-l1";
import { BaseUiP1Section } from "./sections/base-ui-p1";
import { BaseUiP2Section } from "./sections/base-ui-p2";
import { BaseUiP3Section } from "./sections/base-ui-p3";
import { ChatL1Section } from "./sections/chat-l1";
import { ChatL2Section } from "./sections/chat-l2";
import { ChatL3Section } from "./sections/chat-l3";
import { ChatL4Section } from "./sections/chat-l4";
import { DataL1Section } from "./sections/data-l1";
import { DataL2Section } from "./sections/data-l2";
import { DesignTokensSection } from "./sections/design-tokens";
import { FileL1Section } from "./sections/file-l1";
import { FileL2Section } from "./sections/file-l2";
import { PreviewL1Section } from "./sections/preview-l1";
import { PreviewL2Section } from "./sections/preview-l2";
import { WorkbenchL1Section } from "./sections/workbench-l1";
import { WorkbenchL2Section } from "./sections/workbench-l2";

/**
 * demo 外壳：左侧分层导航 + 右侧分区内容，顶部提供语言与主题切换。
 *
 * 分区切换只用 useState —— demo 不需要路由，保持零额外依赖。
 *
 * 导航顺序即组件层级顺序，也即「从通用到具体」的依赖方向：
 *   Design Tokens（变量）→ Base UI P1/P2/P3（页面骨架 → 通用容器 → 基础控件与下沉的通用件）
 *   → Chat L1–L4（会话外壳 → 主区 → 元件 → 消息基元）
 *   → 各业务域 L 系列（File / Preview / Workbench / Data / Agent）。
 * 分区 id 同时是 demo 命名空间下 `sections.<id>` 与 `sectionHints.<id>` 的文案键，两者必须一一对应。
 */

type SectionId =
  | "designTokens"
  | "baseUiP1"
  | "baseUiP2"
  | "baseUiP3"
  | "chatL1"
  | "chatL2"
  | "chatL3"
  | "chatL4"
  | "fileL1"
  | "fileL2"
  | "previewL1"
  | "previewL2"
  | "workbenchL1"
  | "workbenchL2"
  | "dataL1"
  | "dataL2"
  | "agentL1";

const SECTION_IDS: SectionId[] = [
  "designTokens",
  "baseUiP1",
  "baseUiP2",
  "baseUiP3",
  "chatL1",
  "chatL2",
  "chatL3",
  "chatL4",
  "fileL1",
  "fileL2",
  "previewL1",
  "previewL2",
  "workbenchL1",
  "workbenchL2",
  "dataL1",
  "dataL2",
  "agentL1",
];

const SECTION_COMPONENTS: Record<SectionId, ComponentType> = {
  designTokens: DesignTokensSection,
  baseUiP1: BaseUiP1Section,
  baseUiP2: BaseUiP2Section,
  baseUiP3: BaseUiP3Section,
  chatL1: ChatL1Section,
  chatL2: ChatL2Section,
  chatL3: ChatL3Section,
  chatL4: ChatL4Section,
  fileL1: FileL1Section,
  fileL2: FileL2Section,
  previewL1: PreviewL1Section,
  previewL2: PreviewL2Section,
  workbenchL1: WorkbenchL1Section,
  workbenchL2: WorkbenchL2Section,
  dataL1: DataL1Section,
  dataL2: DataL2Section,
  agentL1: AgentL1Section,
};

const LANGUAGES: Array<{ value: DemoLanguage; label: string }> = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

export function App() {
  const { t } = useTranslation(DEMO_NS);
  const [activeSection, setActiveSection] = useState<SectionId>("designTokens");

  // 语言状态直接从 i18n 实例读取：useTranslation 已订阅 languageChanged，切换后会重渲染本组件。
  const language = getDemoLanguage();
  const ActiveSection = SECTION_COMPONENTS[activeSection];

  return (
    <div className="demo-shell">
      <nav className="demo-nav">
        <div className="demo-nav-title">{t("appTitle")}</div>
        {SECTION_IDS.map((id) => (
          <button
            key={id}
            type="button"
            className="demo-nav-item"
            data-active={id === activeSection}
            onClick={() => setActiveSection(id)}
          >
            {t(`sections.${id}`)}
          </button>
        ))}
      </nav>

      <main className="demo-main">
        <header className="demo-topbar">
          <span className="demo-topbar-label">{t("language")}</span>
          {LANGUAGES.map((option) => (
            <Button
              key={option.value}
              size="sm"
              variant={language === option.value ? "default" : "ghost"}
              onClick={() => {
                void changeDemoLanguage(option.value);
              }}
            >
              {option.label}
            </Button>
          ))}
          <ThemeToggle />
        </header>

        <div className="demo-content">
          <ActiveSection />
        </div>
      </main>
    </div>
  );
}

export default App;
