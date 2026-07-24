import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() =>
  import("../../../pages/agent-panel/pages/ExternalIframePage").then((m) => ({
    default: () => (
      <m.ExternalIframePage
        titleKey="agentPanel:ragflow"
        subtitle="RAGFlow 知识库管理与检索增强，管理文档、构建知识库和配置 RAG 流程"
        iframeUrl="/ragflow/"
        preflightUrl="/web/external-services/ragflow/ensure-login?force=1"
      />
    ),
  })),
);

export const Route = createFileRoute("/agent/_panel/ragflow")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-brand border-t-transparent" />
        </div>
      }
    >
      <Page />
    </Suspense>
  ),
});
