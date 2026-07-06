import { createFileRoute } from "@tanstack/react-router";

/**
 * chat session 路由桩 — 实际渲染由 AgentPanelLayout 中的 ChatArea 组件处理。
 * ChatArea 始终挂载，通过 CSS display 控制可见性，实现 keep-alive 效果。
 * 本文件仅保留路由定义，不渲染任何内容。
 */
export const Route = createFileRoute("/agent/_panel/chat/$agentId_/$sessionId")({
  component: () => null,
});
