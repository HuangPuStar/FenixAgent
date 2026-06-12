import { createFileRoute } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { extractChangedFiles } from "../../../../src/lib/extract-changed-files";
import type { ThreadEntry } from "../../../../src/lib/types";

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

  // 路由层只需 entries 派生 changedFiles，环境名/token 由 ChatComposer 内部获取
  const [entries, setEntries] = useState<ThreadEntry[]>([]);

  // 从 entries 派生变更文件列表，实时跟随对话更新
  const changedFiles = useMemo(() => extractChangedFiles(entries), [entries]);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      setEntries(detail.entries ?? []);
    };
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
      <div className="agent-panel-content">
        <div className="agent-chat-area">
          <ChatPanel agentId={agentId} sessionId={sessionId} />
        </div>
        <ArtifactsPanel collapsed={artifactsCollapsed} envId={agentId} changedFiles={changedFiles} />
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
