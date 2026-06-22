import { createFileRoute } from "@tanstack/react-router";
import { PanelRight } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePanelRef } from "react-resizable-panels";
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable";
import { extractChangedFiles } from "../../../../src/lib/extract-changed-files";
import type { ThreadEntry } from "../../../../src/lib/types";
import { cn } from "../../../../src/lib/utils";

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

  // ArtifactsPanel 对应的 ResizablePanel imperative handle，用于 collapse/expand/isCollapsed
  const artifactsPanelRef = usePanelRef();
  // 上一次 onResize 时的折叠状态，仅在状态翻转时同步 React state（避免拖拽中频繁 re-render）
  const artifactsCollapsedRef = useRef(true);
  // toggle 按钮的视觉状态，由 Panel.onResize 同步
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

  // Panel 尺寸变化时同步折叠状态到 React state（仅在 isCollapsed() 翻转时触发）
  const handleArtifactsResize = useCallback(() => {
    const panel = artifactsPanelRef.current;
    if (!panel) return;
    const collapsed = panel.isCollapsed();
    if (collapsed !== artifactsCollapsedRef.current) {
      artifactsCollapsedRef.current = collapsed;
      setArtifactsCollapsed(collapsed);
    }
  }, [artifactsPanelRef]);

  // mount 时：默认折叠右侧面板
  // 原因：ResizablePanel 的 defaultSize="40%" 会让面板初始就展开 40%，与 React state 的初始 true（折叠）不一致；
  // 用户希望"右侧面板只有有文件时才展开"，这里在 mount 时立即 collapse 对齐初始意图。
  // 后续 changedFiles 出现 diff 时由下面的 useEffect 触发自动展开。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅 mount 时执行一次，artifactsPanelRef 是 usePanelRef() 返回的稳定 RefObject
  useEffect(() => {
    artifactsPanelRef.current?.collapse();
  }, []);

  // 首次出现 diff 文件时自动展开文件区域（用户手动收起后不再自动展开）
  const prevDiffCountRef = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: artifactsPanelRef 是 usePanelRef() 返回的稳定 RefObject，依赖项只需感知 changedFiles.length 变化
  useEffect(() => {
    if (prevDiffCountRef.current === 0 && changedFiles.length > 0 && artifactsCollapsedRef.current) {
      artifactsPanelRef.current?.expand();
    }
    prevDiffCountRef.current = changedFiles.length;
  }, [changedFiles.length]);

  // toggle 按钮：折叠 ↔ 展开（直接调用 PanelImperativeHandle，不维护额外 state）
  const toggleArtifacts = useCallback(() => {
    const panel = artifactsPanelRef.current;
    if (!panel) return;
    if (panel.isCollapsed()) {
      panel.expand();
    } else {
      panel.collapse();
    }
  }, [artifactsPanelRef]);

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <div className="agent-panel-content">
        {/*
          chat + ArtifactsPanel 拖动布局：用 react-resizable-panels 实现可拖动分隔。
          - chat 区默认 60%，最小 30%，保证聊天输入区可用宽度
          - ArtifactsPanel 默认 40%，collapsible + collapsedSize=0 实现完全折叠
          - onResize 同步折叠状态到 React state（仅在状态翻转时），驱动 toggle 按钮视觉
        */}
        <ResizablePanelGroup orientation="horizontal" className="agent-panel-resizable">
          <ResizablePanel defaultSize="60%" minSize="30%">
            <div className="agent-chat-area">
              <ChatPanel agentId={agentId} sessionId={sessionId} />
            </div>
          </ResizablePanel>

          {/*
            ResizableHandle 同时承载拖动和 toggle 按钮：按钮作为 children 嵌入手柄中央，
            鼠标按下+移动触发拖动，按下+松开（不移动）触发 click 切换折叠。
            这样按钮始终跟随分隔线，不会遮挡手柄命中区。
          */}
          <ResizableHandle>
            <button
              type="button"
              className={cn("agent-artifacts-expand-btn", !artifactsCollapsed && "open")}
              onClick={toggleArtifacts}
              title={artifactsCollapsed ? t("showArtifacts") : t("hideArtifacts")}
            >
              {artifactsCollapsed ? (
                <PanelRight className="h-3.5 w-3.5" />
              ) : (
                <PanelRight className="h-3.5 w-3.5 -scale-x-100" />
              )}
            </button>
          </ResizableHandle>

          <ResizablePanel
            panelRef={artifactsPanelRef}
            defaultSize="40%"
            minSize="20%"
            maxSize="70%"
            collapsible
            collapsedSize="0%"
            onResize={handleArtifactsResize}
          >
            <ArtifactsPanel key={agentId} envId={agentId} changedFiles={changedFiles} />
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Suspense>
  );
}
