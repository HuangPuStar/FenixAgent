import {
    useState,
    useEffect,
    useCallback,
    lazy,
    Suspense,
    useMemo,
} from "react";
import { Toaster } from "sonner";
import { AppShell, type NavItem } from "./components/shell";
import { ThemeProvider } from "./lib/theme";
import { authClient, useSession } from "./lib/auth-client";
import { LoginPage } from "./pages/LoginPage";
import { ApiKeyManager } from "./pages/ApiKeyManager";
import {
    LayoutDashboard,
    Cpu,
    Bot,
    Wrench,
    Plug,
    MessageSquare,
    Clock,
    KeyRound,
} from "lucide-react";

const Dashboard = lazy(() =>
    import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const SessionDetail = lazy(() =>
    import("./pages/SessionDetail").then((m) => ({ default: m.SessionDetail })),
);
const ModelsPage = lazy(() =>
    import("./pages/ModelsPage").then((m) => ({ default: m.ModelsPage })),
);
const AgentsPage = lazy(() =>
    import("./pages/AgentsPage").then((m) => ({ default: m.AgentsPage })),
);
const SkillsPage = lazy(() =>
    import("./pages/SkillsPage").then((m) => ({ default: m.SkillsPage })),
);
const McpPage = lazy(() =>
    import("./pages/McpPage").then((m) => ({ default: m.McpPage })),
);
const TasksPage = lazy(() =>
    import("./pages/TasksPage").then((m) => ({ default: m.TasksPage })),
);
const ChannelsPage = lazy(() =>
    import("./pages/ChannelsPage").then((m) => ({ default: m.ChannelsPage })),
);

export function parseConfigView(pathname: string): string | null {
    const configViews = ["models", "agents", "skills", "mcp", "tasks", "channels"];
    const segment = pathname.replace(/^\/code\/?/, "").split("/")[0];
    return configViews.includes(segment) ? segment : null;
}

type ViewId =
    | "dashboard"
    | "session"
    | "apikeys"
    | "login"
    | "models"
    | "agents"
    | "skills"
    | "mcp"
    | "tasks"
    | "channels";

export default function App() {
    const { data: session, isPending } = useSession();
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(
        null,
    );
    const [showApiKeys, setShowApiKeys] = useState(false);
    const [configView, setConfigView] = useState<string | null>(null);

    const parseRoute = useCallback(() => {
        const path = window.location.pathname;
        const configViews = ["models", "agents", "skills", "mcp", "tasks", "channels"];
        const segment = path.replace(/^\/code\/?/, "").split("/")[0];
        if (configViews.includes(segment)) {
            setConfigView(segment);
            setCurrentSessionId(null);
        } else {
            setConfigView(null);
            const match = path.match(/^\/code\/([^/]+)$/);
            if (
                match &&
                match[1] &&
                match[1] !== "login" &&
                match[1] !== "api-keys" &&
                !configViews.includes(match[1])
            ) {
                setCurrentSessionId(match[1]);
                window.history.replaceState(null, "", `/code/${match[1]}/`);
            } else {
                const pathMatch = path.match(/^\/code\/([^/]+)/);
                if (
                    pathMatch &&
                    pathMatch[1] &&
                    pathMatch[1] !== "login" &&
                    pathMatch[1] !== "api-keys" &&
                    !configViews.includes(pathMatch[1])
                ) {
                    setCurrentSessionId(pathMatch[1]);
                } else {
                    setCurrentSessionId(null);
                }
            }
        }
    }, []);

    useEffect(() => {
        parseRoute();
        window.addEventListener("popstate", parseRoute);
        return () => window.removeEventListener("popstate", parseRoute);
    }, [parseRoute]);

    const navigateToSession = useCallback((sessionId: string) => {
        window.history.pushState(null, "", `/code/${sessionId}/`);
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
    const activeView: ViewId = showApiKeys
        ? "apikeys"
        : configView
          ? (configView as ViewId)
          : currentSessionId
            ? "session"
            : "dashboard";

    const navItems: NavItem[] = useMemo(
        () => [
            {
                id: "dashboard",
                label: "仪表盘",
                icon: <LayoutDashboard className="h-4 w-4" />,
                active: activeView === "dashboard" || activeView === "session",
                onClick: navigateToDashboard,
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
                label: "Agent",
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
                id: "mcp",
                label: "MCP",
                icon: <Plug className="h-4 w-4" />,
                active: activeView === "mcp",
                onClick: () => navigateToConfig("mcp"),
            },
            {
                id: "channels",
                label: "通道",
                icon: <MessageSquare className="h-4 w-4" />,
                active: activeView === "channels",
                onClick: () => navigateToConfig("channels"),
            },
            {
                id: "tasks",
                label: "定时任务",
                icon: <Clock className="h-4 w-4" />,
                active: activeView === "tasks",
                onClick: () => navigateToConfig("tasks"),
            },
            {
                id: "apikeys",
                label: "API Key",
                icon: <KeyRound className="h-4 w-4" />,
                active: activeView === "apikeys",
                onClick: navigateToApiKeys,
            },
        ],
        [activeView, navigateToDashboard, navigateToApiKeys, navigateToConfig],
    );

    if (isPending) {
        return (
            <div className="flex h-screen items-center justify-center text-text-muted">
                加载中...
            </div>
        );
    }

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
                navItems={navItems}
                userEmail={userEmail}
                onLogout={handleLogout}>
                <Suspense
                    fallback={
                        <div className="flex h-full items-center justify-center text-text-muted">
                            加载中...
                        </div>
                    }>
                    {showApiKeys ? (
                        <ApiKeyManager onBack={navigateToDashboard} />
                    ) : configView === "models" ? (
                        <ModelsPage />
                    ) : configView === "agents" ? (
                        <AgentsPage />
                    ) : configView === "skills" ? (
                        <SkillsPage />
                    ) : configView === "mcp" ? (
                        <McpPage />
                    ) : configView === "tasks" ? (
                        <TasksPage />
                    ) : configView === "channels" ? (
                        <ChannelsPage />
                    ) : currentSessionId ? (
                        <SessionDetail
                            key={currentSessionId}
                            sessionId={currentSessionId}
                        />
                    ) : (
                        <Dashboard onNavigateToSession={navigateToSession} />
                    )}
                </Suspense>
            </AppShell>
            <Toaster richColors position="top-right" />
        </ThemeProvider>
    );
}
