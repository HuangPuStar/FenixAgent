import { agentSitesApi, type SiteApp } from "@fenix/agent-config/web";
import { envApi } from "@fenix/agent-runtime/web/api/environments";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { NS } from "@/src/i18n";

interface UseArtifactsSitesOptions {
  envId: string | null;
  agentConfigId?: string | null;
  /**
   * 站点卡片请求选中站点时切到 Sites 模式。事件监听只注册一次（依赖 `[]`），
   * 实现须保持稳定引用；本 hook 内部再经 ref 读取，避免未来回调换引用后读到旧值。
   */
  onEnterSitesMode: () => void;
}

/**
 * 输出面板的 Sites 数据编排：解析 agentConfigId → 拉站点列表 → 绑定/解绑 mutation → 选中态与弹窗态。
 *
 * 从 `ArtifactsPanel.tsx` 拆出（§4.7）：面板壳只管模式切换与渲染，站点这一整条数据流连同它的
 * 乐观更新、事件监听、弹窗状态都归本 hook，壳不再需要读它的内部状态。
 */
export function useArtifactsSites({
  envId,
  agentConfigId: agentConfigIdProp,
  onEnterSitesMode,
}: UseArtifactsSitesOptions) {
  const { t } = useTranslation(NS.COMPONENTS);

  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  const configIdRef = useRef(agentConfigIdProp);
  configIdRef.current = agentConfigIdProp;

  const [mountDialogOpen, setMountDialogOpen] = useState(false);
  const [unmountConfirm, setUnmountConfirm] = useState<{ id: string; name: string } | null>(null);

  const { data: envData } = useRequest(() => unwrap(envApi.get({ id: envId! })), {
    ready: agentConfigIdProp == null && !!envId,
    onError: (err: unknown) => {
      console.warn("[ArtifactsPanel] 加载 environment 详情失败，Sites tab 不可用", err);
    },
  });
  const resolvedAgentConfigId = envData?.agentConfigId ?? null;
  const agentConfigId = agentConfigIdProp != null ? agentConfigIdProp : resolvedAgentConfigId;
  configIdRef.current = agentConfigId ?? undefined;

  const {
    run: loadSites,
    loading: sitesLoading,
    data: sites = [],
    error: sitesLoadError,
    mutate: setSites,
  } = useRequest(
    async (cfgId: string) => {
      const list = (await unwrap(agentSitesApi.listByAgentConfig(cfgId))) as SiteApp[];
      return (Array.isArray(list) ? list : [])
        .filter((item): item is SiteApp => !!item)
        .map((item) => ({
          id: item.id,
          name: item.name,
          remoteAppId: item.remoteAppId,
          createdByAgentConfigId: item.createdByAgentConfigId ?? null,
          createdByAgentConfigName: item.createdByAgentConfigName ?? null,
        }))
        .filter((item) => item.id && item.remoteAppId);
    },
    {
      manual: true,
      onError: (err: unknown) => {
        console.error("[ArtifactsPanel] 加载 agent 绑定 sites 失败", err);
        // 加载失败在 0 站点时不会命中下面的行内错误条（那条要求 sites.length > 0），
        // 此时界面会落进「未绑定站点」空态，把失败伪装成空数据；toast 是这里唯一的失败信号。
        toast.error(t("panelMode.sitesLoadFailed"));
      },
    },
  );

  const sitesRef = useRef(sites);
  sitesRef.current = sites;

  // ── useRequest：卸载 site mutation（manual） ──────────
  const { run: runUnmount, loading: unmounting } = useRequest(
    async (cfgId: string, siteId: string) => {
      await unwrap(agentSitesApi.unbindSite(cfgId, siteId));
    },
    {
      manual: true,
      onSuccess: (_data, params) => {
        const [, siteId] = params as [string, string];
        setUnmountConfirm(null);
        // 乐观更新：立即剔除已解绑 site，避免 loadSites 异步延迟期间
        // 旧 tab 残留（responsiveSiteId 派生自动回退到剩余 site 或 null）
        setSites((prev) => (prev ?? []).filter((s) => s.id !== siteId));
        // 后台确认：从 DB 拉最新列表，确保最终一致性
        if (agentConfigId) loadSites(agentConfigId);
      },
      onError: () => {
        toast.error(t("panelMode.unmountFailed"));
      },
    },
  );

  // ── useRequest：自动绑定的 mutation（manual） ─────────
  const { run: runBind, loading: binding } = useRequest(
    async (cfgId: string, siteId: string) => {
      await unwrap(agentSitesApi.bindSite(cfgId, siteId));
    },
    {
      manual: true,
      onSuccess: (_data, params) => {
        const [bindCfgId, bindSiteId] = params as [string, string];
        loadSites(bindCfgId);
        setTimeout(() => {
          const fresh = sitesRef.current.find((s) => s.remoteAppId === bindSiteId);
          setActiveSiteId(fresh?.id ?? null);
        }, 100);
      },
      onError: (err: unknown) => {
        console.error("[ArtifactsPanel] 自动挂载站点失败", err);
        // 失败由用户点击 <agent-sites> 卡片触发，已切到 Sites 模式但选不中站点，
        // 不提示会让用户以为点击没生效。
        toast.error(t("panelMode.mountFailed"));
      },
    },
  );
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  const enterSitesModeRef = useRef(onEnterSitesMode);
  enterSitesModeRef.current = onEnterSitesMode;

  // 监听 <agent-sites> 卡片点击事件：切到 Sites 模式并选中对应 site
  // 卡片组件触发 artifacts:select-site 时：
  // 1. 切到 Sites 模式（由面板壳实现，本 hook 只发请求）
  // 2. 在已绑定的 sites 中按 remoteAppId 查找并选中
  // 3. 若未绑定：自动调用 bindSite 挂载（通过 runBind mutation hook），刷新列表后选中
  // handler 不重新注册，靠 ref 获取最新值。
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { siteId: string };
      if (!detail?.siteId) return;

      const siteId = detail.siteId; // remoteAppId（如 "app-91a0621c"）
      const currentSites = sitesRef.current;
      const cfgId = configIdRef.current;

      enterSitesModeRef.current();

      // 在已绑定的 sites 中按 remoteAppId 查找
      const matched = currentSites.find((s) => s.remoteAppId === siteId);
      if (matched) {
        setActiveSiteId(matched.id);
        return;
      }

      // 未绑定 → 自动挂载（并发锁由 useRequest loading 状态提供）
      if (!cfgId || bindingRef.current) return;
      runBind(cfgId, siteId);
    };
    window.addEventListener("artifacts:select-site", handler);
    return () => window.removeEventListener("artifacts:select-site", handler);
  }, []);

  // agent 切换：清空选中并重载列表（模式与角标的复位归面板壳与 use-artifacts-files）
  useEffect(() => {
    setActiveSiteId(null);

    if (!agentConfigId) {
      setSites([]);
      return;
    }
    void loadSites(agentConfigId);
  }, [agentConfigId, loadSites, setSites]);

  const handleSiteChange = useCallback((siteId: string) => {
    setActiveSiteId(siteId);
  }, []);

  const handleMount = useCallback(() => {
    if (!agentConfigId) return;
    setMountDialogOpen(true);
  }, [agentConfigId]);
  const handleMounted = useCallback(() => {
    setMountDialogOpen(false);
    if (agentConfigId) void loadSites(agentConfigId);
  }, [agentConfigId, loadSites]);
  const handleUnmountClick = useCallback(
    (siteId: string) => {
      const site = sites.find((s) => s.id === siteId);
      if (site) setUnmountConfirm({ id: site.id, name: site.name });
    },
    [sites],
  );

  // 渲染前派生：activeSiteId 可能因 agent 切换后 sites 重新加载而指向不存在的 id，
  // 此时回退到 sites[0]。不在 effect 里 setActiveSiteId 修正，避免多一次渲染。
  const validActiveSiteId =
    activeSiteId && sites.some((s) => s.id === activeSiteId) ? activeSiteId : (sites[0]?.id ?? null);
  const activeSite = sites.find((s) => s.id === validActiveSiteId) ?? null;

  return {
    /** Sites 数据流解析出的 agentConfigId（入参优先，否则取 environment 详情） */
    agentConfigId,
    sites,
    sitesLoading,
    sitesLoadError,
    unmounting,
    validActiveSiteId,
    activeSite,
    mountDialogOpen,
    setMountDialogOpen,
    unmountConfirm,
    setUnmountConfirm,
    setActiveSiteId,
    handleSiteChange,
    handleMount,
    handleMounted,
    handleUnmountClick,
    runUnmount,
  };
}
