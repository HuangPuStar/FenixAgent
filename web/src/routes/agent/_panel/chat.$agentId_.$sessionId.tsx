import { createFileRoute } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadEntry } from "../../../../src/lib/types";
import { StatusHeader } from "../../../components/agent-panel/StatusHeader";

const ChatPanel = lazy(() => import("../../../pages/agent-panel/ChatPanel").then((m) => ({ default: m.ChatPanel })));
const ArtifactsPanel = lazy(() =>
  import("../../../pages/agent-panel/ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })),
);

export const Route = createFileRoute("/agent/_panel/chat/$agentId_/$sessionId")({
  component: ChatWithSessionRoute,
});

function ChatWithSessionRoute() {
  const { agentId, sessionId } = Route.useParams();
  const { t } = useTranslation("agentPanel");

  const [artifactsCollapsed, setArtifactsCollapsed] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-collapsed");
    return saved === "true";
  });

  const [stats, setStats] = useState<{ agentName?: string; modelName?: string; entries: ThreadEntry[] }>({
    entries: [],
  });

  useEffect(() => {
    const handler = (e: Event) => setStats((e as CustomEvent).detail);
    window.addEventListener("chat:stats", handler);
    return () => window.removeEventListener("chat:stats", handler);
  }, []);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-collapsed", String(artifactsCollapsed));
  }, [artifactsCollapsed]);

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <StatusHeader agentName={stats.agentName} modelName={stats.modelName} entries={stats.entries} />
      <div className="agent-panel-content">
        <div className="agent-chat-area">
          <ChatPanel agentId={agentId} sessionId={sessionId} />
        </div>
        <ArtifactsPanel
          collapsed={artifactsCollapsed}
          onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
          envId={agentId}
        />
        {artifactsCollapsed && (
          <button
            type="button"
            className="agent-artifacts-expand-btn"
            onClick={() => setArtifactsCollapsed(false)}
            title={t("showArtifacts")}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </Suspense>
  );
}
