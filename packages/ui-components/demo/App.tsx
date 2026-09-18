import { Button, ThemeToggle } from "@fenix/ui-components";
import { type ComponentType, useState } from "react";
import { useTranslation } from "react-i18next";

import { changeDemoLanguage, DEMO_NS, type DemoLanguage, getDemoLanguage } from "./i18n";
import { AiSection } from "./sections/ai";
import { CompositeSection } from "./sections/composite";
import { DataSection } from "./sections/data";
import { FeedbackSection } from "./sections/feedback";
import { FormsSection } from "./sections/forms";
import { OverlaySection } from "./sections/overlay";
import { PrimitivesSection } from "./sections/primitives";
import { ThemeSection } from "./sections/theme";

/**
 * demo 外壳：左侧分组导航 + 右侧分区内容，顶部提供语言与主题切换。
 *
 * 分区切换只用 useState —— demo 不需要路由，保持零额外依赖。
 * 分区 id 同时是 demo 命名空间下 `sections.<id>` 的文案键，两者必须一一对应。
 */

type SectionId = "primitives" | "forms" | "data" | "feedback" | "overlay" | "ai" | "composite" | "theme";

const SECTION_IDS: SectionId[] = ["primitives", "forms", "data", "feedback", "overlay", "ai", "composite", "theme"];

const SECTION_COMPONENTS: Record<SectionId, ComponentType> = {
  primitives: PrimitivesSection,
  forms: FormsSection,
  data: DataSection,
  feedback: FeedbackSection,
  overlay: OverlaySection,
  ai: AiSection,
  composite: CompositeSection,
  theme: ThemeSection,
};

const LANGUAGES: Array<{ value: DemoLanguage; label: string }> = [
  { value: "en", label: "EN" },
  { value: "zh", label: "中文" },
];

export function App() {
  const { t } = useTranslation(DEMO_NS);
  const [activeSection, setActiveSection] = useState<SectionId>("primitives");

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
