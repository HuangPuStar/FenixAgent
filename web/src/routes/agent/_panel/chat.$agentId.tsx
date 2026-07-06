import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * chat 路由桩 — 实际渲染由 AgentPanelLayout 中的 ChatArea 组件处理。
 * ChatArea 始终挂载，通过 CSS display 控制可见性，实现 keep-alive 效果。
 * 本文件仅保留 beforeLoad redirect 校验。
 */
export const Route = createFileRoute("/agent/_panel/chat/$agentId")({
  beforeLoad: ({ params }) => {
    if (params.agentId === "_new") {
      throw redirect({ to: "/agent/home" });
    }
  },
  component: () => null,
});
