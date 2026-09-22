import { cn } from "@fenix/ui-components/lib/cn";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Cpu, Database, Eye, Layers3, Server, Sparkles } from "lucide-react";
import { useTranslation } from "react-i18next";
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

/** 加载壳导航行：与 `agent-editor-map [data-slot="tabs-trigger"]` 的骨架行高/列宽同构（46px / 27px 图标列）。 */
const LOADING_MAP_ROW =
  "grid min-h-[46px] grid-cols-[27px_minmax(0,1fr)] items-center gap-2 rounded-[11px] px-2 py-[5px] text-[#56657c]";
/** 选中态行：颜色与底色覆盖基行（twMerge 保留后者）。 */
const LOADING_MAP_ROW_ACTIVE = "text-[#174aa9] bg-[#eaf2ff]";

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
    <div className="agent-editor-root" aria-busy="true">
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
      <div className="agent-editor-workspace">
        <nav className="agent-editor-map" aria-label={t("editor.configurationMap")}>
          <span className="agent-editor-map-label">{t("editor.configurationMap")}</span>
          <div className="grid gap-[3px]">
            {LOADING_SECTIONS.map(({ id, icon: Icon }, index) => (
              <div className={cn(LOADING_MAP_ROW, index === 0 && LOADING_MAP_ROW_ACTIVE)} key={id}>
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
          {/* 字段骨架：两列 62px 高，末行跨列且高 170px（与加载后的字段网格同构）。 */}
          <div className="grid grid-cols-[repeat(2,minmax(0,1fr))] gap-[14px] [&>div]:h-[62px] [&>div:last-child]:col-span-full [&>div:last-child]:h-[170px] [@media(max-width:759px)]:grid-cols-1">
            <Skeleton />
            <Skeleton />
            <Skeleton />
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
