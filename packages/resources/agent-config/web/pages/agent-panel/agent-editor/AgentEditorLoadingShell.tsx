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
  MAP_COPY_CAPTION,
  MAP_COPY_TITLE,
  MAP_ICON,
  MAP_LABEL,
  SECTION_INTRO,
  TEMPLATE_PANEL,
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
                  <Icon className="w-3.5" />
                </span>
                <span className={MAP_COPY} data-slot="editor-map-copy">
                  <strong className={MAP_COPY_TITLE} data-slot="editor-map-copy-title">
                    {t(`editor.sections.${id}`)}
                  </strong>
                  <small className={MAP_COPY_CAPTION} data-slot="editor-map-copy-caption">
                    {t(`editor.sectionCaptions.${id}`)}
                  </small>
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
          <div className="grid grid-cols-2 gap-3.5 max-md:grid-cols-1">
            <Skeleton className="h-15.5" />
            <Skeleton className="h-15.5" />
            <Skeleton className="col-span-full h-42.5" />
          </div>
          <span className="sr-only">{t("editor.loading")}</span>
        </main>
        {/* 右栏骨架与完成态的模板面板同构：眉标 / 标题 / 说明 / 搜索框 / 模板卡。
            加载期无从判断模板是否存在（`data` 未到，`templates.length > 0` 还不成立），按常见情形占位；
            数据到达后由完成态决定右栏去留（无模板时走 `NO_TEMPLATE_PANEL` 回落两列），本壳随之卸载。 */}
        <aside className={TEMPLATE_PANEL} aria-hidden="true">
          <Skeleton className="h-2.5 w-16" />
          <Skeleton className="mt-2 h-4 w-28" />
          <Skeleton className="mt-2 h-3 w-full" />
          <Skeleton className="mt-3.5 h-9 w-full" />
          <Skeleton className="mt-2.5 h-14 w-full" />
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
