import { useState, useEffect, useCallback, lazy, Suspense, useMemo } from "react";
import { Toaster } from "sonner";
import { AppShell, type SidebarItem } from "./components/shell";
import { ThemeProvider } from "./lib/theme";
import { authClient, useSession } from "./lib/auth-client";
import { LoginPage } from "./pages/LoginPage";
import { ApiKeyManager } from "./pages/ApiKeyManager";
import {
  LayoutDashboard,
  MessageSquare,
  KeyRound,
  LogOut,
  Cpu,
  Bot,
  Wrench,
} from "lucide-react";

const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const SessionDetail = lazy(() => import("./pages/SessionDetail").then((m) => ({ default: m.SessionDetail })));
const ModelsPage = lazy(() => import("./pages/ModelsPage").then((m) => ({ default: m.ModelsPage })));
const AgentsPage = lazy(() => import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const SkillsPage = lazy(() => import("./pages/SkillsPage").then((m) => ({ default: m.SkillsPage })));

export function parseConfigView(pathname: string): string | null {
  const configViews = ["models", "agents", "skills"];
  const segment = pathname.replace(/^\/code\/?/, "").split("/")[0];
  return configViews.includes(segment) ? segment : null;
}

type ViewId = "dashboard" | "session" | "apikeys" | "login" | "models" | "agents" | "skills";

export default function App() {
  const { data: session, isPending } = useSession();
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [showApiKeys, setShowApiKeys] = useState(false);
  const [configView, setConfigView] = useState<string | null>(null);

  // Simple hash-based router
  const parseRoute = useCallback(() => {
    const path = window.location.pathname;
    const configViews = ["models", "agents", "skills"];
    const segment = path.replace(/^\/code\/?/, "").split("/")[0];
    if (configViews.includes(segment)) {
      setConfigView(segment);
      setCurrentSessionId(null);
    } else {
      setConfigView(null);
      const match = path.match(/^\/code\/([^/]+)/);
      if (match && match[1] && match[1] !== "login" && match[1] !== "api-keys" && !configViews.includes(match[1])) {
        setCurrentSessionId(match[1]);
      } else {
        setCurrentSessionId(null);
      }
    }
  }, []);

  useEffect(() => {
    parseRoute();
    window.addEventListener("popstate", parseRoute);
    return () => window.removeEventListener("popstate", parseRoute);
  }, [parseRoute]);

  const navigateToSession = useCallback((sessionId: string) => {
    window.history.pushState(null, "", `/code/${sessionId}`);
    setCurrentSessionId(sessionId);
  }, []);

  const navigateToDashboard = useCallback(() => {
    window.history.pushState(null, "", "/code/");
    setCurrentSessionId(null);
    setShowApiKeys(false);
    setConfigView(null);
  }, []);

  const navigateToApiKeys = useCallback(() => {
    setShowApiKeys(true);
    setCurrentSessionId(null);
    setConfigView(null);
  }, []);

  const navigateToConfig = useCallback((view: string) => {
    window.history.pushState(null, "", `/code/${view}`);
    setConfigView(view);
    setShowApiKeys(false);
    setCurrentSessionId(null);
  }, []);

  const handleLogout = useCallback(async () => {
    await authClient.signOut();
    window.location.reload();
  }, []);

  const userEmail = session?.user?.email ?? "";
  const activeView: ViewId =
    showApiKeys ? "apikeys" :
    configView ? configView as ViewId :
    currentSessionId ? "session" : "dashboard";

  const navItems: SidebarItem[] = useMemo(() => [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: <LayoutDashboard className="h-4 w-4" />,
      active: activeView === "dashboard",
      onClick: navigateToDashboard,
    },
    ...(currentSessionId && !showApiKeys && !configView ? [{
      id: "session",
      label: "Session",
      icon: <MessageSquare className="h-4 w-4" />,
      active: true,
      badge: "ACP",
      onClick: () => {},
    }] : []),
  ], [activeView, currentSessionId, configView, navigateToDashboard]);

  const footerItems: SidebarItem[] = useMemo(() => [
    {
      id: "apikeys",
      label: "API Keys",
      icon: <KeyRound className="h-4 w-4" />,
      active: activeView === "apikeys",
      onClick: navigateToApiKeys,
    },
    {
      id: "models",
      label: "模型",
      icon: <Cpu className="h-4 w-4" />,
      active: activeView === "models",
      onClick: () => navigateToConfig("models"),
    },
    {
      id: "agents",
      label: "代理",
      icon: <Bot className="h-4 w-4" />,
      active: activeView === "agents",
      onClick: () => navigateToConfig("agents"),
    },
    {
      id: "skills",
      label: "技能",
      icon: <Wrench className="h-4 w-4" />,
      active: activeView === "skills",
      onClick: () => navigateToConfig("skills"),
    },
    {
      id: "logout",
      label: userEmail,
      icon: <LogOut className="h-4 w-4" />,
      onClick: handleLogout,
    },
  ], [activeView, userEmail, navigateToApiKeys, navigateToConfig, handleLogout]);

  const pageTitle = useMemo(() => {
    if (showApiKeys) return "API Keys";
    if (configView) {
      const titles: Record<string, string> = { models: "模型", agents: "代理", skills: "技能" };
      return titles[configView] || "配置";
    }
    if (currentSessionId) return "Session";
    return "Dashboard";
  }, [showApiKeys, configView, currentSessionId]);

  // Loading session state
  if (isPending) {
    return (
      <div className="flex h-screen items-center justify-center text-text-muted">
        Loading...
      </div>
    );
  }

  // Not authenticated — show login page
  if (!session) {
    return (
      <ThemeProvider defaultTheme="system">
        <LoginPage onLogin={() => window.location.reload()} />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider defaultTheme="system">
      <AppShell
        activeView={activeView}
        navItems={navItems}
        footerItems={footerItems}
        title={pageTitle}
      >
        <Suspense fallback={
          <div className="flex h-full items-center justify-center text-text-muted">Loading...</div>
        }>
          {showApiKeys ? (
            <ApiKeyManager onBack={navigateToDashboard} />
          ) : configView === "models" ? (
            <ModelsPage />
          ) : configView === "agents" ? (
            <AgentsPage />
          ) : configView === "skills" ? (
            <SkillsPage />
          ) : currentSessionId ? (
            <SessionDetail key={currentSessionId} sessionId={currentSessionId} />
          ) : (
            <Dashboard onNavigateSession={navigateToSession} />
          )}
        </Suspense>
      </AppShell>
      <Toaster richColors position="top-right" />
    </ThemeProvider>
  );
}
