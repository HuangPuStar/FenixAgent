import { useState, useEffect, useCallback, lazy, Suspense, useMemo } from "react";
import { AppShell, type SidebarItem } from "./components/shell";
import { IdentityPanel } from "./components/IdentityPanel";
import { TokenManagerDialog } from "./components/TokenManagerDialog";
import { ThemeProvider } from "./lib/theme";
import { getUuid, setUuid, apiBind, setActiveApiToken } from "./api/client";
import { ACPDirectView } from "./components/ACPDirectView";
import { useTokens } from "./hooks/useTokens";
import {
  LayoutDashboard,
  MessageSquare,
  Monitor,
  KeyRound,
  UserPlus,
} from "lucide-react";

const Dashboard = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.Dashboard })));
const SessionDetail = lazy(() => import("./pages/SessionDetail").then((m) => ({ default: m.SessionDetail })));

type ViewId = "dashboard" | "session";

export default function App() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [identityOpen, setIdentityOpen] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [acpDirect, setAcpDirect] = useState<{ url: string; token: string } | null>(null);
  const { tokens, activeTokenId, activeLabel, activeTokenValue, setActiveTokenId, addToken, removeToken, updateToken } = useTokens();

  // Sync active token to API client
  useEffect(() => {
    setActiveApiToken(activeTokenValue);
  }, [activeTokenValue]);

  const handleSetActiveToken = useCallback((id: string) => {
    setActiveTokenId(id);
  }, [setActiveTokenId]);

  // Simple hash-based router
  const parseRoute = useCallback(() => {
    getUuid();

    const path = window.location.pathname;
    const params = new URLSearchParams(window.location.search);
    const importUuid = params.get("uuid");
    if (importUuid) {
      setUuid(importUuid);
      const url = new URL(window.location.href);
      url.searchParams.delete("uuid");
      window.history.replaceState(null, "", url);
    }

    const acpParam = params.get("acp");
    if (acpParam === "1") {
      const stored = sessionStorage.getItem("acp_connection");
      if (stored) {
        try {
          const acpData = JSON.parse(stored);
          if (acpData.url && acpData.token) {
            setAcpDirect({ url: acpData.url, token: acpData.token });
            sessionStorage.removeItem("acp_connection");
            // Clean URL
            const url = new URL(window.location.href);
            url.searchParams.delete("acp");
            window.history.replaceState(null, "", url);
            return;
          }
        } catch {
          sessionStorage.removeItem("acp_connection");
        }
      }
    }

    // Check for CLI session bind (?sid=xxx) — bind session to current UUID
    const sid = params.get("sid");
    if (sid) {
      const url = new URL(window.location.href);
      url.searchParams.delete("sid");
      window.history.replaceState(null, "", `/code/${sid}`);
      setCurrentSessionId(sid);
      // Bind this session to the current user's UUID for ownership
      apiBind(sid).catch((err: unknown) => {
        console.warn("Failed to bind session:", err);
      });
      return;
    }

    // Path-based routing: /code/session_xxx → session detail
    const match = path.match(/^\/code\/([^/]+)/);
    if (match && match[1]) {
      setCurrentSessionId(match[1]);
    } else {
      setCurrentSessionId(null);
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
    setAcpDirect(null);
  }, []);

  const activeView: ViewId = currentSessionId || acpDirect ? "session" : "dashboard";

  const navItems: SidebarItem[] = useMemo(() => [
    {
      id: "dashboard",
      label: "Dashboard",
      icon: <LayoutDashboard className="h-4 w-4" />,
      active: activeView === "dashboard",
      onClick: navigateToDashboard,
    },
    ...(currentSessionId ? [{
      id: "session",
      label: "Session",
      icon: <MessageSquare className="h-4 w-4" />,
      active: true,
      badge: "ACP",
      onClick: () => {},
    }] : []),
  ], [activeView, currentSessionId, navigateToDashboard]);

  const footerItems: SidebarItem[] = useMemo(() => [
    {
      id: "tokens",
      label: activeLabel || "No Token",
      icon: <KeyRound className="h-4 w-4" />,
      onClick: () => setTokenDialogOpen(true),
    },
    {
      id: "identity",
      label: "Identity",
      icon: <UserPlus className="h-4 w-4" />,
      onClick: () => setIdentityOpen(true),
    },
  ], [activeLabel]);

  const pageTitle = useMemo(() => {
    if (acpDirect) return "ACP Direct";
    if (currentSessionId) return "Session";
    return "Dashboard";
  }, [acpDirect, currentSessionId]);

  return (
    <ThemeProvider defaultTheme="system">
      <AppShell
        activeView={activeView}
        navItems={navItems}
        footerItems={footerItems}
        title={pageTitle}
        topBarRight={
          activeLabel && !currentSessionId && !acpDirect ? (
            <span className="flex items-center gap-1 rounded-md bg-brand/10 px-2 py-1 text-xs font-medium text-brand">
              <KeyRound className="h-3 w-3" />
              {activeLabel}
            </span>
          ) : undefined
        }
      >
        <Suspense fallback={
          <div className="flex h-full items-center justify-center text-text-muted">Loading...</div>
        }>
          {acpDirect ? (
            <ACPDirectView url={acpDirect.url} token={acpDirect.token} onBack={navigateToDashboard} />
          ) : currentSessionId ? (
            <SessionDetail key={currentSessionId} sessionId={currentSessionId} />
          ) : (
            <Dashboard onNavigateSession={navigateToSession} />
          )}
        </Suspense>

        <IdentityPanel open={identityOpen} onClose={() => setIdentityOpen(false)} />

        <TokenManagerDialog
          open={tokenDialogOpen}
          onClose={() => setTokenDialogOpen(false)}
          tokens={tokens}
          activeTokenId={activeTokenId}
          onSetActive={handleSetActiveToken}
          onAdd={addToken}
          onRemove={removeToken}
          onUpdate={updateToken}
        />
      </AppShell>
    </ThemeProvider>
  );
}
