import { Cpu, Database, Eye, Layers3, Server, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Skeleton } from "@/components/ui/skeleton";
import { NS } from "../../../i18n";
import { AgentEditorHeader } from "./AgentEditorChrome";
import type { AgentEditorSection } from "./AgentEditorSections";

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
    <div className="agent-editor-root agent-editor-loading-shell" aria-busy="true">
      <AgentEditorHeader
        title={mode === "create" ? t("dialog.createTitle") : t("dialog.editTitle")}
        name={name}
        agentId={null}
        readOnly
        showTemplate={false}
        templateTriggerRef={{ current: null }}
        onTemplate={() => undefined}
        onClose={onClose}
      />
      <div className="agent-editor-workspace">
        <nav className="agent-editor-map" aria-label={t("editor.configurationMap")}>
          <span className="agent-editor-map-label">{t("editor.configurationMap")}</span>
          <div className="agent-editor-loading-shell__map">
            {LOADING_SECTIONS.map(({ id, icon: Icon }, index) => (
              <div className={index === 0 ? "is-active" : ""} key={id}>
                <span className="agent-editor-map-icon">
                  <Icon />
                </span>
                <span className="agent-editor-map-copy">
                  <strong>{t(`editor.sections.${id}`)}</strong>
                  <small>{t(`editor.sectionCaptions.${id}`)}</small>
                </span>
              </div>
            ))}
          </div>
        </nav>
        <main className="agent-editor-content" role="status" aria-live="polite">
          <div className="agent-editor-section__intro">
            <Skeleton className="h-2 w-16" />
            <Skeleton className="h-7 w-40" />
            <Skeleton className="h-3 w-72 max-w-full" />
          </div>
          <div className="agent-editor-loading-shell__fields">
            <Skeleton />
            <Skeleton />
            <Skeleton className="is-wide" />
          </div>
          <span className="sr-only">{t("editor.loading")}</span>
        </main>
        <aside className="agent-editor-summary" aria-hidden="true">
          <Skeleton className="h-3 w-20" />
          <Skeleton className="mt-4 h-14 w-full" />
          <Skeleton className="mt-2 h-14 w-full" />
          <Skeleton className="mt-2 h-14 w-full" />
        </aside>
      </div>
      <footer className="agent-editor-footer" aria-hidden="true">
        <Skeleton className="h-3 w-32" />
        <Skeleton className="h-8 w-24" />
      </footer>
    </div>
  );
}
