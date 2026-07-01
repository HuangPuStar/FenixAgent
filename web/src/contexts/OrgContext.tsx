import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { orgApi } from "@/src/api/organizations";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";

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
  const { t } = useTranslation(NS.COMPONENTS);
  const [org, setOrg] = useState<OrgInfo | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [orgs, setOrgs] = useState<OrgWithRole[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshOrgs = useCallback(async () => {
    try {
      const raw = await unwrap(orgApi.list());
      // 运行时数据包含 role 字段，但 OrgInfo 类型未声明，透传转型
      const list = raw as unknown as OrgWithRole[];
      setOrgs(list);
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
      // 快照当前值，用于失败时回滚
      const oldOrgId = org?.id;
      const _oldRole = role;
      const storedOrgId = localStorage.getItem(STORAGE_KEY);

      // 乐观更新 UI 和 localStorage（即时反馈）
      const target = orgs.find((o) => o.id === orgId);
      if (target) {
        setOrg(target);
        setRole(target.role ?? "");
      }
      localStorage.setItem(STORAGE_KEY, orgId);

      try {
        await unwrap(orgApi.setActive(orgId));
        // 成功后导航到首页，触发组件重建和数据重载
        void navigate({ to: "/agent/home", replace: true });
      } catch (err) {
        console.error("Failed to switch org:", err);
        // 回滚 localStorage
        if (storedOrgId) {
          localStorage.setItem(STORAGE_KEY, storedOrgId);
        } else {
          localStorage.removeItem(STORAGE_KEY);
        }
        // 回滚 React state
        if (oldOrgId) {
          const oldTarget = orgs.find((o) => o.id === oldOrgId);
          if (oldTarget) {
            setOrg(oldTarget);
            setRole(oldTarget.role ?? "");
          }
        }
        toast.error(t("orgSwitchFailed", { message: (err as Error).message }));
      }
    },
    [navigate, orgs, org, role, t],
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
