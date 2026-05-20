import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { AgentSidebar } from "./AgentSidebar";
import { ChatPanel } from "./ChatPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import "./agent-panel.css";

interface AgentAppShellProps {
  /** 初始选中的 agentId（从 URL 解析） */
  initialAgentId?: string | null;
  /** 初始 sessionId */
  initialSessionId?: string | null;
}

export function AgentAppShell({ initialAgentId, initialSessionId }: AgentAppShellProps) {
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(initialAgentId ?? null);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(initialSessionId ?? null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    const saved = localStorage.getItem("agent-panel:sidebar-collapsed");
    return saved === "true";
  });

  const [artifactsCollapsed, setArtifactsCollapsed] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-collapsed");
    return saved === "true";
  });

  const [chatEntries, setChatEntries] = useState<unknown[]>([]);

  // 响应式：窄屏自动折叠
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) {
        setSidebarCollapsed(true);
        setArtifactsCollapsed(true);
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  // 持久化折叠状态
  useEffect(() => {
    localStorage.setItem("agent-panel:sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-collapsed", String(artifactsCollapsed));
  }, [artifactsCollapsed]);

  // 选中实例 → 更新 URL
  const handleSelectInstance = useCallback((instanceId: string, envId: string, sessionId: string | null) => {
    setSelectedInstanceId(instanceId);
    setSelectedAgentId(envId);
    setCurrentSessionId(sessionId);
    if (sessionId) {
      window.history.pushState(null, "", `/ctrl/agent/${envId}/${sessionId}`);
    } else {
      window.history.pushState(null, "", `/ctrl/agent/${envId}`);
    }
  }, []);

  // 配置导航跳转（回到旧布局）
  const handleNavigate = useCallback((pageId: string) => {
    if (pageId === "dashboard") {
      window.location.href = "/ctrl/";
    } else if (pageId === "apikeys") {
      window.location.href = "/ctrl/";
    } else {
      window.location.href = `/ctrl/${pageId}`;
    }
  }, []);

  return (
    <div className="agent-panel-layout">
      {/* 左侧边栏 */}
      <AgentSidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        selectedInstanceId={selectedInstanceId}
        onSelectInstance={handleSelectInstance}
        onNavigate={handleNavigate}
      />

      {/* 中间聊天区域 */}
      <div className="agent-chat-area">
        <ChatPanel agentId={selectedAgentId} sessionId={currentSessionId} />
      </div>

      {/* 右侧 Artifacts 面板 */}
      <ArtifactsPanel
        collapsed={artifactsCollapsed}
        onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
        entries={chatEntries}
      />

      {/* Artifacts 折叠时的展开按钮 */}
      {artifactsCollapsed && (
        <button
          type="button"
          className="agent-artifacts-expand-btn"
          onClick={() => setArtifactsCollapsed(false)}
          title="显示内容面板"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
