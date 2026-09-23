import "./AgentEditorLoadingShell.css";
import { cn } from "@fenix/ui-components/lib/cn";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Cpu, Database, Eye, Layers3, Server, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { AgentEditorHeader } from "./AgentEditorChrome";
import type { AgentEditorSection } from "./AgentEditorSections";
import {
  CONFIG_MAP,
  CONTENT,
  EDITOR_ROOT,
  FOOTER,
  LOADING_MAP_ROW,
  LOADING_MAP_ROW_ACTIVE,
  MAP_COPY,
  MAP_ICON,
  MAP_LABEL,
  SECTION_INTRO,
  SUMMARY_ASIDE,
  WORKSPACE,
} from "./agent-editor-classes";

const LOADING_SECTIONS: Array<{ id: AgentEditorSection; icon: typeof Sparkles }> = [
  { id: "identity", icon: Sparkles },
  { id: "model", icon: Cpu },
  { id: "capabilities", icon: Layers3 },
  { id: "knowledge", icon: Database },
  { id: "runtime", icon: Server },
  { id: "sharing", icon: Eye },
];

/** 首批数据到达前保持完整编辑器框架稳定，避免用整页 spinner 阻塞弹窗打开反馈。 */
export function AgentEditorLoadingShell({
  mode,
  name,
  onClose,
}: {
  mode: "create" | "edit";
  name: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <div className={EDITOR_ROOT} aria-busy="true">
      <AgentEditorHeader
        title={mode === "create" ? t("dialog.createTitle") : t("dialog.editTitle")}
        name={name}
        agentId={null}
        readOnly
        loading
        showTemplate={false}
        templateTriggerRef={{ current: null }}
        onTemplate={() => undefined}
        onClose={onClose}
      />
      <div className={WORKSPACE}>
        <nav className={CONFIG_MAP} aria-label={t("editor.configurationMap")}>
          <span className={MAP_LABEL} data-slot="editor-map-label">
            {t("editor.configurationMap")}
          </span>
          <div className="grid gap-0.75">
            {LOADING_SECTIONS.map(({ id, icon: Icon }, index) => (
              <div className={cn(LOADING_MAP_ROW, index === 0 && LOADING_MAP_ROW_ACTIVE)} key={id}>
                <span className={MAP_ICON}>
                  <Icon />
                </span>
                <span className={MAP_COPY} data-slot="editor-map-copy">
                  <strong>{t(`editor.sections.${id}`)}</strong>
                  <small>{t(`editor.sectionCaptions.${id}`)}</small>
                </span>
              </div>
            ))}
          </div>
        </nav>
        <main className={CONTENT} role="status" aria-live="polite">
          <div className={SECTION_INTRO}>
            <Skeleton className="h-2 w-16" />
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          {/* 字段骨架：两列 62px 高，末行跨列且高 170px（与加载后的字段网格同构）。 */}
          <div className="agent-editor-loading-fields grid gap-3.5 max-md:grid-cols-1">
            <Skeleton />
            <Skeleton />
            <Skeleton />
          </div>
          <span className="sr-only">{t("editor.loading")}</span>
        </main>
        <aside className={SUMMARY_ASIDE} aria-hidden="true">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-4 h-14 w-full" />
          <Skeleton className="mt-2 h-14 w-full" />
          <Skeleton className="mt-2 h-14 w-full" />
        </aside>
      </div>
      <footer className={FOOTER} aria-hidden="true">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-24" />
      </footer>
    </div>
  );
}
