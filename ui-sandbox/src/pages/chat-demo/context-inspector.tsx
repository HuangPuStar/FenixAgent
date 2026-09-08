import { CalendarClock, Eye, Files, Globe, PanelRight, PanelRightDashed, Plus, X } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useRef, useState } from "react";
import type { ContextTab, DemoScenarioId } from "./demo-model";
import { Button, Tabs, TabsContent, TabsList, TabsTrigger } from "./demo-ui";
import { FilesPanel } from "./files-panel";
import { useDemoTranslation } from "./use-demo-copy";

interface ContextInspectorProps {
  scenarioId: DemoScenarioId;
  activeTab: ContextTab;
  canDock: boolean;
  mode: "floating" | "docked";
  width: number;
  onTabChange: (tab: ContextTab) => void;
  onClose: () => void;
  onModeChange: (mode: "floating" | "docked") => void;
  onWidthChange: (width: number) => void;
}

const CONTEXT_TABS = [
  { id: "files", icon: Files },
  { id: "sites", icon: Globe },
  { id: "tasks", icon: CalendarClock },
  { id: "views", icon: Eye },
] as const;

/** Mirrors the production ArtifactsPanel modes with local-only mock interactions. */
export function ContextInspector({
  scenarioId,
  activeTab,
  canDock,
  mode,
  width,
  onTabChange,
  onClose,
  onModeChange,
  onWidthChange,
}: ContextInspectorProps) {
  const { t } = useDemoTranslation();
  const [resizing, setResizing] = useState(false);
  const resizeStartRef = useRef<{ pointerId: number; x: number; width: number } | null>(null);
  const widthBounds = () => {
    const minimum = 320;
    const maximum =
      mode === "docked"
        ? Math.max(minimum, Math.min(600, window.innerWidth - 830))
        : Math.max(minimum, Math.min(720, window.innerWidth * 0.62));
    return { minimum, maximum };
  };
  const clampWidth = (nextWidth: number) => {
    const { minimum, maximum } = widthBounds();
    return Math.min(maximum, Math.max(minimum, nextWidth));
  };
  const finishResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const resizeStart = resizeStartRef.current;
    if (resizeStart && event.currentTarget.hasPointerCapture(resizeStart.pointerId)) {
      event.currentTarget.releasePointerCapture(resizeStart.pointerId);
    }
    resizeStartRef.current = null;
    setResizing(false);
  };
  const nextMode = mode === "floating" ? "docked" : "floating";
  const ModeIcon = mode === "floating" ? PanelRightDashed : PanelRight;

  return (
    <aside
      className={`chat-demo__context${resizing ? " is-resizing" : ""}`}
      style={{ width, flexBasis: width }}
      data-layout={mode}
      aria-label={t("context.title")}
    >
      <div
        className="chat-demo__context-resizer"
        role="separator"
        tabIndex={0}
        aria-label={t("controls.resizeContext")}
        aria-orientation="vertical"
        aria-valuemin={widthBounds().minimum}
        aria-valuemax={widthBounds().maximum}
        aria-valuenow={Math.round(width)}
        onPointerDown={(event) => {
          resizeStartRef.current = { pointerId: event.pointerId, x: event.clientX, width };
          event.currentTarget.setPointerCapture(event.pointerId);
          setResizing(true);
        }}
        onPointerMove={(event) => {
          const resizeStart = resizeStartRef.current;
          if (!resizeStart || resizeStart.pointerId !== event.pointerId) return;
          onWidthChange(clampWidth(resizeStart.width + resizeStart.x - event.clientX));
        }}
        onPointerUp={finishResize}
        onPointerCancel={finishResize}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          onWidthChange(clampWidth(width + (event.key === "ArrowLeft" ? 16 : -16)));
        }}
      />
      <Tabs
        value={activeTab}
        className="chat-demo__context-tabs-root"
        onValueChange={(value) => onTabChange(value as ContextTab)}
      >
        <header className="chat-demo__context-header">
          <TabsList className="chat-demo__context-tabs" aria-label={t("context.title")}>
            {CONTEXT_TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger key={tab.id} value={tab.id}>
                  <Icon />
                  {t(`context.${tab.id}`)}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <div className="chat-demo__context-actions">
            {canDock && (
              <button
                type="button"
                className="chat-demo__context-layout-toggle"
                aria-label={t(`controls.${nextMode === "docked" ? "dockContext" : "floatContext"}`)}
                onClick={() => {
                  const nextMaximum =
                    nextMode === "docked"
                      ? Math.max(320, Math.min(600, window.innerWidth - 830))
                      : Math.max(320, Math.min(720, window.innerWidth * 0.62));
                  onWidthChange(Math.min(width, nextMaximum));
                  onModeChange(nextMode);
                }}
              >
                <ModeIcon />
                <span>{mode === "floating" ? "浮动" : "固定"}</span>
              </button>
            )}
            <Button variant="ghost" size="icon-xs" aria-label={t("controls.closeContext")} onClick={onClose}>
              <X />
            </Button>
          </div>
        </header>
        <div className="chat-demo__context-body">
          <TabsContent value="files">
            <FilesPanel scenarioId={scenarioId} />
          </TabsContent>
          <TabsContent value="sites">
            <SitesPanel />
          </TabsContent>
          <TabsContent value="tasks">
            <ScheduledTasksPanel />
          </TabsContent>
          <TabsContent value="views">
            <ViewsPanel />
          </TabsContent>
        </div>
      </Tabs>
    </aside>
  );
}

function SitesPanel() {
  const { t } = useDemoTranslation();
  const [activeSite, setActiveSite] = useState("docs");
  return (
    <div className="chat-demo__mode-panel">
      <div className="chat-demo__mode-toolbar">
        <strong>{t("context.sitesTitle")}</strong>
        <Button size="xs">
          <Plus />
          {t("context.mountSite")}
        </Button>
      </div>
      <div className="chat-demo__site-switcher">
        {(["docs", "preview"] as const).map((site) => (
          <button
            key={site}
            type="button"
            className={activeSite === site ? "is-active" : undefined}
            onClick={() => setActiveSite(site)}
          >
            <Globe />
            <span>{t(`context.site.${site}`)}</span>
            <small>{t("context.site.online")}</small>
          </button>
        ))}
      </div>
      <div className="chat-demo__site-preview">
        <span>{t(`context.site.${activeSite}Url`)}</span>
        <strong>{t(`context.site.${activeSite}Title`)}</strong>
      </div>
    </div>
  );
}

function ScheduledTasksPanel() {
  const { t } = useDemoTranslation();
  return (
    <div className="chat-demo__mode-panel">
      <div className="chat-demo__mode-toolbar">
        <strong>{t("context.scheduledTitle")}</strong>
        <Button size="icon-xs">
          <Plus />
        </Button>
      </div>
      <div className="chat-demo__schedule-list">
        {(["release", "knowledge", "report"] as const).map((task, index) => (
          <button key={task} type="button">
            <CalendarClock />
            <div>
              <strong>{t(`context.schedule.${task}`)}</strong>
              <small>{t(`context.schedule.${task}Time`)}</small>
            </div>
            <span className={index === 1 ? "is-paused" : undefined}>
              {t(index === 1 ? "context.paused" : "context.enabled")}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ViewsPanel() {
  const { t } = useDemoTranslation();
  const [enabled, setEnabled] = useState(true);
  return (
    <div className="chat-demo__mode-panel">
      <div className="chat-demo__mode-toolbar">
        <strong>{t("context.viewsTitle")}</strong>
        <Button size="xs">
          <Plus />
          {t("context.createView")}
        </Button>
      </div>
      <div className="chat-demo__view-card">
        <Eye />
        <div className="chat-demo__view-copy">
          <strong>{t("context.viewName")}</strong>
          <small>{t("context.viewDescription")}</small>
          <code>{t("context.viewUrl")}</code>
        </div>
        <button type="button" className={enabled ? "is-enabled" : undefined} onClick={() => setEnabled(!enabled)}>
          <i />
          {t(enabled ? "context.enabled" : "context.disabled")}
        </button>
      </div>
    </div>
  );
}
