import { createFileRoute, redirect } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { extractChangedFiles } from "../../../../src/lib/extract-changed-files";
import type { ThreadEntry } from "../../../../src/lib/types";
import { cn } from "../../../../src/lib/utils";

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

  // 默认隐藏：只有 Agent 产出 diff 文件后才自动展开文件区域
  const [artifactsCollapsed, setArtifactsCollapsed] = useState(true);

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

  // 首次出现 diff 文件时自动展开文件区域（用户手动收起后不再自动展开）
  const prevDiffCountRef = useRef(0);
  useEffect(() => {
    if (prevDiffCountRef.current === 0 && changedFiles.length > 0 && artifactsCollapsed) {
      setArtifactsCollapsed(false);
    }
    prevDiffCountRef.current = changedFiles.length;
  }, [changedFiles.length, artifactsCollapsed]);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setArtifactsCollapsed(true);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

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
          <ChatPanel agentId={agentId} />
        </div>
        <ArtifactsPanel key={agentId} collapsed={artifactsCollapsed} envId={agentId} changedFiles={changedFiles} />
        <button
          type="button"
          className={cn("agent-artifacts-expand-btn", !artifactsCollapsed && "open")}
          onClick={() => setArtifactsCollapsed((v) => !v)}
          title={artifactsCollapsed ? t("showArtifacts") : t("hideArtifacts")}
        >
          {artifactsCollapsed ? (
            <PanelRight className="h-3.5 w-3.5" />
          ) : (
            <PanelRight className="h-3.5 w-3.5 -scale-x-100" />
          )}
        </button>
      </div>
    </Suspense>
  );
}
