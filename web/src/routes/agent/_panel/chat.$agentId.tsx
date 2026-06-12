import { createFileRoute, redirect } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { envApi } from "../../../../src/api/sdk";
import { extractChangedFiles } from "../../../../src/lib/extract-changed-files";
import type { ThreadEntry } from "../../../../src/lib/types";
import { StatusHeader } from "../../../components/agent-panel/StatusHeader";

const ChatPanel = lazy(() => import("../../../pages/agent-panel/ChatPanel").then((m) => ({ default: m.ChatPanel })));
const ArtifactsPanel = lazy(() =>
  import("../../../pages/agent-panel/ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })),
);

export const Route = createFileRoute("/agent/_panel/chat/$agentId")({
  beforeLoad: ({ params }) => {
    if (params.agentId === "_new") {
      throw redirect({ to: "/agent/home" });
    }
  },
  component: ChatRoute,
});

function ChatRoute() {
  const { agentId } = Route.useParams();
  const { t } = useTranslation("agentPanel");

  const [artifactsCollapsed, setArtifactsCollapsed] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-collapsed");
    return saved === "true";
  });

  const [envName, setEnvName] = useState<string | null>(null);

  const [stats, setStats] = useState<{ agentName?: string; modelName?: string; entries: ThreadEntry[] }>({
    entries: [],
  });

  // 从 entries 派生变更文件列表，实时跟随对话更新
  const changedFiles = useMemo(() => extractChangedFiles(stats.entries), [stats.entries]);

  // 加载 environment 名称
  useEffect(() => {
    if (!agentId) {
      setEnvName(null);
      return;
    }
    envApi
      .get({ id: agentId })
      .then(({ data }) => setEnvName(data?.name ?? null))
      .catch(() => setEnvName(null));
  }, [agentId]);

  useEffect(() => {
    const handler = (e: Event) => {
      setStats((e as CustomEvent).detail);
    };
    window.addEventListener("chat:stats", handler);
    return () => window.removeEventListener("chat:stats", handler);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setArtifactsCollapsed(true);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
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
      <StatusHeader agentName={envName || stats.agentName} modelName={stats.modelName} entries={stats.entries} />
      <div className="agent-panel-content">
        <div className="agent-chat-area">
          <ChatPanel agentId={agentId} />
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
