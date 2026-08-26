import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ChatCanvas } from "./chat-canvas";
import { ContextInspector } from "./context-inspector";
import { type ContextTab, type DemoScenarioId, getDemoScenario } from "./demo-model";
import { DemoPanelBoundary } from "./demo-panel-boundary";
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./demo-ui";
import { ScenarioRail } from "./scenario-rail";
import { useDemoTranslation } from "./use-demo-copy";
import "./chat-demo.css";

export function ChatDemoPage() {
  const { t } = useDemoTranslation();
  const [scenarioId, setScenarioId] = useState<DemoScenarioId>("conversation");
  const [contextTab, setContextTab] = useState<ContextTab>("files");
  const [contextOpen, setContextOpen] = useState(() => window.matchMedia("(min-width: 1051px)").matches);
  const [contextMode, setContextMode] = useState<"floating" | "docked">("floating");
  const [contextWidth, setContextWidth] = useState(430);
  const [contextCompact, setContextCompact] = useState(() => window.matchMedia("(max-width: 1050px)").matches);
  const [railCollapsed, setRailCollapsed] = useState(false);
  const [resetKey, setResetKey] = useState(0);
  const scenario = getDemoScenario(scenarioId);

  useEffect(() => {
    const mediaQuery = window.matchMedia("(max-width: 1050px)");
    const handleViewportChange = (event: MediaQueryListEvent) => {
      setContextCompact(event.matches);
      if (event.matches) setContextMode("floating");
    };
    mediaQuery.addEventListener("change", handleViewportChange);
    return () => mediaQuery.removeEventListener("change", handleViewportChange);
  }, []);

  const handleScenarioChange = useCallback((nextId: DemoScenarioId) => {
    const nextScenario = getDemoScenario(nextId);
    setScenarioId(nextId);
    setContextTab(nextScenario.contextTab);
    setResetKey((key) => key + 1);
  }, []);

  return (
    <TooltipProvider delayDuration={250}>
      <main className="chat-demo" data-context-open={contextOpen} data-context-mode={contextMode}>
        <section className="chat-demo__workspace">
          <header className="chat-demo__topbar">
            <div className="chat-demo__topbar-title">
              <span className="chat-demo__status-dot" data-status={scenario.status} />
              <h1>{t(`scenarios.${scenarioId}.title`)}</h1>
            </div>
            <div className="chat-demo__topbar-actions">
              <span className="chat-demo__mock-badge">{t("status.mock")}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="icon-sm" onClick={() => setContextOpen((open) => !open)}>
                    {contextOpen ? <PanelRightClose /> : <PanelRightOpen />}
                    <span className="sr-only">
                      {contextOpen ? t("controls.closeContext") : t("controls.openContext")}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{contextOpen ? t("controls.closeContext") : t("controls.openContext")}</TooltipContent>
              </Tooltip>
            </div>
          </header>

          <div className="chat-demo__workspace-body">
            <DemoPanelBoundary>
              <ScenarioRail
                activeScenarioId={scenarioId}
                collapsed={railCollapsed}
                onScenarioChange={handleScenarioChange}
                onCollapsedChange={setRailCollapsed}
              />
            </DemoPanelBoundary>
            <div className="chat-demo__workgrid">
              <DemoPanelBoundary>
                <ChatCanvas key={`${scenarioId}-${resetKey}`} scenarioId={scenarioId} />
              </DemoPanelBoundary>
              {contextOpen && (
                <DemoPanelBoundary>
                  <ContextInspector
                    key={`${scenarioId}-${resetKey}`}
                    scenarioId={scenarioId}
                    activeTab={contextTab}
                    canDock={!contextCompact}
                    mode={contextMode}
                    width={contextWidth}
                    onTabChange={setContextTab}
                    onClose={() => setContextOpen(false)}
                    onModeChange={setContextMode}
                    onWidthChange={setContextWidth}
                  />
                </DemoPanelBoundary>
              )}
            </div>
          </div>
        </section>
      </main>
    </TooltipProvider>
  );
}
