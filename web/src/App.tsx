import {
    useState,
    useEffect,
    useCallback,
    lazy,
    Suspense,
} from "react";
import { Toaster } from "sonner";
import { AppShell } from "./components/shell";
import { ThemeProvider } from "./lib/theme";
import { useSession } from "./lib/auth-client";
import { LoginPage } from "./pages/LoginPage";
import { ApiKeyManager } from "./pages/ApiKeyManager";

const Dashboard = lazy(() =>
    import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })),
);
const EnvironmentsPage = lazy(() =>
    import("./pages/EnvironmentsPage").then((m) => ({ default: m.EnvironmentsPage })),
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
const WorkflowPage = lazy(() =>
    import("./pages/WorkflowPage").then((m) => ({ default: m.WorkflowPage })),
);

export function parseConfigView(pathname: string): string | null {
    const configViews = ["models", "agents", "skills", "mcp", "tasks", "channels", "workflow", "environments"];
    const segment = pathname.replace(/^\/ctrl\/?/, "").split("/")[0];
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
    | "channels"
    | "workflow"
    | "environments";

export default function App() {
    const { data: session, isPending } = useSession();
    const [currentSessionId, setCurrentSessionId] = useState<string | null>(
        null,
    );
    const [currentSessionCwd, setCurrentSessionCwd] = useState<string | null>(null);
    const [showApiKeys, setShowApiKeys] = useState(false);
    const [configView, setConfigView] = useState<string | null>(null);

    const parseRoute = useCallback(() => {
        const path = window.location.pathname;
        const params = new URLSearchParams(window.location.search);
        const configViews = ["models", "agents", "skills", "mcp", "tasks", "channels", "workflow", "environments"];
        const segment = path.replace(/^\/ctrl\/?/, "").split("/")[0];
        if (configViews.includes(segment)) {
            setConfigView(segment);
            setCurrentSessionId(null);
            setCurrentSessionCwd(null);
        } else {
            setConfigView(null);
            const match = path.match(/^\/ctrl\/([^/]+)$/);
            if (
                match &&
                match[1] &&
                match[1] !== "login" &&
                match[1] !== "api-keys" &&
                !configViews.includes(match[1])
            ) {
                setCurrentSessionId(match[1]);
                setCurrentSessionCwd(params.get("cwd"));
                window.history.replaceState(null, "", `/ctrl/${match[1]}/`);
            } else {
                const pathMatch = path.match(/^\/ctrl\/([^/]+)/);
                if (
                    pathMatch &&
                    pathMatch[1] &&
                    pathMatch[1] !== "login" &&
                    pathMatch[1] !== "api-keys" &&
                    !configViews.includes(pathMatch[1])
                ) {
                    setCurrentSessionId(pathMatch[1]);
                    setCurrentSessionCwd(params.get("cwd"));
                } else {
                    setCurrentSessionId(null);
                    setCurrentSessionCwd(null);
                }
            }
        }
    }, []);

    useEffect(() => {
        parseRoute();
        window.addEventListener("popstate", parseRoute);
        return () => window.removeEventListener("popstate", parseRoute);
    }, [parseRoute]);

    const navigateToSession = useCallback((sessionId: string, options?: { cwd?: string }) => {
        const params = new URLSearchParams();
        if (options?.cwd) {
            params.set("cwd", options.cwd);
        }
        const query = params.toString();
        window.history.pushState(null, "", `/ctrl/${sessionId}/${query ? `?${query}` : ""}`);
        setConfigView(null);
        setShowApiKeys(false);
        setCurrentSessionId(sessionId);
        setCurrentSessionCwd(options?.cwd ?? null);
    }, []);

    const navigateToDashboard = useCallback(() => {
        window.history.pushState(null, "", "/ctrl/");
        setCurrentSessionId(null);
        setCurrentSessionCwd(null);
        setShowApiKeys(false);
        setConfigView(null);
    }, []);

    const navigateToApiKeys = useCallback(() => {
        setShowApiKeys(true);
        setCurrentSessionId(null);
        setCurrentSessionCwd(null);
        setConfigView(null);
    }, []);

    const navigateToConfig = useCallback((view: string) => {
        window.history.pushState(null, "", `/ctrl/${view}`);
        setConfigView(view);
        setShowApiKeys(false);
        setCurrentSessionId(null);
        setCurrentSessionCwd(null);
    }, []);

    const activeView: ViewId = showApiKeys
        ? "apikeys"
        : configView
          ? (configView as ViewId)
          : currentSessionId
            ? "session"
            : "dashboard";

    /** Route navigation events from Sidebar to the correct handler */
    const handleNavigate = useCallback((page: string) => {
        if (page === "dashboard") {
            navigateToDashboard();
        } else if (page === "apikeys") {
            navigateToApiKeys();
        } else {
            navigateToConfig(page);
        }
    }, [navigateToDashboard, navigateToApiKeys, navigateToConfig]);

    if (isPending) {
        return (
            <div className="flex h-screen flex-col items-center justify-center gap-4">
                <div className="h-10 w-10 rounded-full border-2 border-brand border-t-transparent animate-spin" />
                <p className="text-sm text-text-muted">正在连接控制面板...</p>
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
                currentPage={activeView}
                onNavigate={handleNavigate}>
                <Suspense
                    fallback={
                        <div className="flex h-full flex-col items-center justify-center gap-3">
                            <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
                            <p className="text-sm text-text-muted">加载中...</p>
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
                    ) : configView === "workflow" ? (
                        <WorkflowPage />
                    ) : configView === "environments" ? (
                        <EnvironmentsPage onNavigateToSession={navigateToSession} />
                    ) : currentSessionId ? (
                        <SessionDetail
                            key={currentSessionId}
                            sessionId={currentSessionId}
                            initialCwd={currentSessionCwd ?? undefined}
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
