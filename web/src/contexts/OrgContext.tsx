import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { orgApi } from "@/src/api/sdk";

interface OrgInfo {
  id: string;
  name: string;
  slug: string;
  logo?: string;
}

interface OrgWithRole extends OrgInfo {
  role: string;
}

interface OrgContextValue {
  org: OrgInfo | null;
  role: string | null;
  orgs: OrgWithRole[];
  loading: boolean;
  switchOrg: (orgId: string) => Promise<void>;
  refreshOrgs: () => Promise<void>;
}

const STORAGE_KEY = "active_org_id";

const OrgContext = createContext<OrgContextValue | null>(null);

/** 给全局 fetch 注入 X-Active-Org-Id header */
let fetchInterceptorInstalled = false;
function installFetchInterceptor() {
  if (fetchInterceptorInstalled) return;
  fetchInterceptorInstalled = true;
  const origFetch = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const activeOrgId = localStorage.getItem(STORAGE_KEY);
    if (activeOrgId) {
      const headers = new Headers(init?.headers);
      if (!headers.has("X-Active-Org-Id")) headers.set("X-Active-Org-Id", activeOrgId);
      init = { ...init, headers };
    }
    return origFetch(input, init);
  }) as typeof fetch;
}

export function OrgProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgWithRole[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshOrgs = useCallback(async () => {
    try {
      const { data: _list, error } = await orgApi.list();
      if (error) {
        console.error("Failed to load org context:", error.message);
        return;
      }
      const list = (_list ?? []) as unknown as OrgWithRole[];
      setOrgs(list);
      // 取当前 active org 或第一个
      const activeOrgId = localStorage.getItem(STORAGE_KEY);
      const current = list.find((o) => o.id === activeOrgId) || list[0];
      if (current) {
        setOrg(current);
        setRole(current.role ?? "");
        localStorage.setItem(STORAGE_KEY, current.id);
      }
    } catch (err) {
      console.error("Failed to load org context:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    installFetchInterceptor();
    refreshOrgs();
  }, [refreshOrgs]);

  const switchOrg = useCallback(
    async (orgId: string) => {
      // 立即更新本地状态，让 UI 立即响应
      const target = orgs.find((o) => o.id === orgId);
      if (target) {
        setOrg(target);
        setRole(target.role ?? "");
      }
      localStorage.setItem(STORAGE_KEY, orgId);
      await orgApi.setActive(orgId);
      // 切换组织后导航回新聊天页，避免停留在旧组织的资源详情页
      void navigate({ to: "/agent/chat/$agentId", params: { agentId: "_new" }, replace: true });
    },
    [navigate, orgs],
  );

  return (
    <OrgContext.Provider value={{ org, role, orgs, loading, switchOrg, refreshOrgs }}>{children}</OrgContext.Provider>
  );
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
}
