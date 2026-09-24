import { unwrap } from "@fenix/web-runtime/api/request";
import { OrgSessionProvider } from "@fenix/web-runtime/contexts/org-session";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { ACTIVE_ORG_STORAGE_KEY, readActiveOrgId } from "@fenix/web-runtime/lib/active-org";
import { useNavigate } from "@tanstack/react-router";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { orgApi } from "../api/organizations";
import { useSession } from "../lib/auth-client";

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

const OrgContext = createContext<OrgContextValue | null>(null);

/**
 * 给全局 fetch 注入 X-Active-Org-Id header。
 * 键与读取动作都经 `@fenix/web-runtime/lib/active-org` 的契约（前端规范 §3.3）：拦截器在 React
 * 之外运行，拿不到 `OrgSession` context，因此它与两条实时通道共用同一份持久化读取，而不是各写一份直读。
 */
let fetchInterceptorInstalled = false;
function installFetchInterceptor() {
  if (fetchInterceptorInstalled) return;
  fetchInterceptorInstalled = true;
  const origFetch = window.fetch;
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const activeOrgId = readActiveOrgId();
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
  // `orgSwitchFailed` 随 §1.6 T9 从宿主 `components` 命名空间搬入本包的 `orgs` 字典：
  // 该键的唯一消费方就是这个 Provider，落在宿主是「键的物理落点 ≠ owner」。
  const { t } = useTranslation(NS.ORGS);
  // 会话是资源包判断资源归属的另一半（`userId`）；本 Provider 是 `OrgSession` 契约的实现方，
  // 因此在这里订阅一次，投影给下游，而不是让每个资源包各自再取一份会话。
  const { data: session, isPending: sessionPending } = useSession();
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
      const activeOrgId = readActiveOrgId();
      const current = list.find((o) => o.id === activeOrgId) || list[0];
      if (current) {
        setOrg(current);
        setRole(current.role ?? "");
        localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, current.id);
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
      const storedOrgId = readActiveOrgId();

      // 乐观更新 UI 和 localStorage（即时反馈）
      const target = orgs.find((o) => o.id === orgId);
      if (target) {
        setOrg(target);
        setRole(target.role ?? "");
      }
      localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, orgId);

      try {
        await unwrap(orgApi.setActive(orgId));
        // 成功后导航到首页，触发组件重建和数据重载
        void navigate({ to: "/agent/home", replace: true });
      } catch (err) {
        console.error("Failed to switch org:", err);
        // 回滚 localStorage
        if (storedOrgId) {
          localStorage.setItem(ACTIVE_ORG_STORAGE_KEY, storedOrgId);
        } else {
          localStorage.removeItem(ACTIVE_ORG_STORAGE_KEY);
        }
        // 回滚 React state
        if (oldOrgId) {
          const oldTarget = orgs.find((o) => o.id === oldOrgId);
          if (oldTarget) {
            setOrg(oldTarget);
            setRole(oldTarget.role ?? "");
          }
        }
        // 上屏只取字典（§9.3）：`err.message` 是 `unwrap` 抛出的 `ApiError.message`（后端信封原文），
        // 只进上面的日志。字典里本就没有 `{{message}}` 槽位，传进去的插值参数一直是死参。
        toast.error(t("orgSwitchFailed"));
      }
    },
    [navigate, orgs, org, role, t],
  );

  const value = useMemo(
    () => ({ org, role, orgs, loading, switchOrg, refreshOrgs }),
    [org, role, orgs, loading, switchOrg, refreshOrgs],
  );

  // 资源包可见的投影（`@fenix/web-runtime/contexts/org-session`）。`isOwner` 取 `role === "owner"`：
  // 角色字符串是身份域词汇，不下沉给资源包。
  const orgSessionValue = useMemo(
    () => ({
      organizationId: org?.id ?? null,
      userId: session?.user?.id ?? null,
      isOwner: role === "owner",
      // 组织列表与会话各自可能在解析中；任一未就绪都意味着投影里的字段还不是最终值。
      pending: loading || sessionPending,
    }),
    [org, session, role, loading, sessionPending],
  );

  return (
    <OrgSessionProvider value={orgSessionValue}>
      <OrgContext.Provider value={value}>{children}</OrgContext.Provider>
    </OrgSessionProvider>
  );
}

export function useOrg() {
  const ctx = useContext(OrgContext);
  if (!ctx) throw new Error("useOrg must be used within OrgProvider");
  return ctx;
}
