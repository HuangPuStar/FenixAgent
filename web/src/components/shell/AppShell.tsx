import { useState, useEffect, type ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface AppShellProps {
    currentPage: string;
    onNavigate: (page: string) => void;
    children: ReactNode;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function AppShell({ currentPage, onNavigate, children }: AppShellProps) {
    const [collapsed, setCollapsed] = useState(false);

    // Auto-collapse sidebar on screens narrower than 768px (md breakpoint)
    useEffect(() => {
        const mq = window.matchMedia("(max-width: 767px)");
        const handler = (e: MediaQueryListEvent | MediaQueryList) => {
            setCollapsed(e.matches);
        };
        handler(mq);
        mq.addEventListener("change", handler);
        return () => mq.removeEventListener("change", handler);
    }, []);

    return (
        <div className="flex h-screen w-screen overflow-hidden bg-surface-0">
            {/* ---- Left sidebar ---- */}
            <Sidebar
                collapsed={collapsed}
                onToggle={() => setCollapsed((v) => !v)}
                currentPage={currentPage}
                onNavigate={onNavigate}
            />

            {/* ---- Right: Topbar + Content ---- */}
            <div className="flex flex-1 flex-col overflow-hidden">
                <Topbar currentPage={currentPage} />

                <main
                    className={
                        currentPage === "session"
                            ? "flex flex-1 flex-col overflow-hidden"
                            : "flex-1 overflow-y-auto"
                    }>
                    {children}
                </main>
            </div>
        </div>
    );
}
