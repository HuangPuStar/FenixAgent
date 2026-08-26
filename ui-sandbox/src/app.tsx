import { useEffect, useState } from "react";
import { Shell } from "./components/shell";
import { NAV_GROUPS, type PageId } from "./navigation";
import { ApiKeysPage, OrganizationsPage } from "./pages/access";
import { ChatDemoPage } from "./pages/chat-demo/chat-demo-page";
import { SitesPage } from "./pages/delivery";
import { DesignTemplatesPage } from "./pages/design-templates";
import { HomePage } from "./pages/home";
import { McpMarketplacePage } from "./pages/mcp-marketplace/mcp-marketplace-page";
import { ModelsPage } from "./pages/models";
import { MemoriesPage, TasksPage } from "./pages/operations";
import { KnowledgeBasesPage } from "./pages/resource-connections";
import { SkillsPage } from "./pages/resources";
import { WorkflowPage } from "./pages/workflow";

const PAGE_IDS = new Set(NAV_GROUPS.flatMap((group) => group.items.map((item) => item.id)));

function readPage(): PageId {
  const value = window.location.hash.replace(/^#\/?/, "") as PageId;
  return PAGE_IDS.has(value) ? value : "home";
}

export function App() {
  const [page, setPage] = useState<PageId>(readPage);
  useEffect(() => {
    const onHashChange = () => setPage(readPage());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  const navigate = (next: PageId) => {
    window.location.hash = next;
    setPage(next);
  };
  return (
    <Shell page={page} onNavigate={navigate}>
      {renderPage(page, navigate)}
    </Shell>
  );
}

function renderPage(page: PageId, navigate: (page: PageId) => void) {
  switch (page) {
    case "home":
      return <HomePage onNavigate={navigate} />;
    case "chat":
      return <ChatDemoPage />;
    case "workflow":
      return <WorkflowPage />;
    case "templates":
      return <DesignTemplatesPage />;
    case "models":
      return <ModelsPage />;
    case "skills":
      return <SkillsPage />;
    case "knowledge-bases":
      return <KnowledgeBasesPage />;
    case "mcp":
      return <McpMarketplacePage />;
    case "tasks":
      return <TasksPage />;
    case "memories":
      return <MemoriesPage />;
    case "sites":
      return <SitesPage />;
    case "organizations":
      return <OrganizationsPage />;
    case "apikeys":
      return <ApiKeysPage />;
  }
}
