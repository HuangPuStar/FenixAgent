import { useRequest } from "ahooks";
import { createContext, type ReactNode, useContext, useMemo, useRef } from "react";
import { getSystemModules } from "../api/system-modules";
import { enabledWebIds } from "./assembly-capabilities";

/** 应用启动快照：所有导航与路由共享一次请求，不按页面或组织重复获取部署能力。 */
export interface AssemblyCapabilitiesState {
  readonly enabled: ReadonlySet<string>;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly retry: () => void;
}

const AssemblyContext = createContext<AssemblyCapabilitiesState | null>(null);

/** 宿主根节点持有请求，资源包不负责拉取或判断部署能力。 */
export function AssemblyCapabilitiesProvider({ children }: { children: ReactNode }) {
  const logged = useRef(false);
  const { data, loading, error, refresh } = useRequest(getSystemModules, {
    cacheKey: "system-assembly-modules",
    staleTime: -1,
    cacheTime: -1,
    onError: () => {
      if (logged.current) return;
      logged.current = true;
      // 只记录固定分类，不输出响应、配置或可能含敏感信息的异常对象。
      console.error({ event: "assembly_modules_fetch_failed", fallback: "build_time_capabilities" });
    },
  });
  const enabled = useMemo(() => enabledWebIds(error ? undefined : data?.web), [data, error]);
  const value = useMemo(
    () => ({ enabled, loading: loading && !data && !error, failed: Boolean(error), retry: refresh }),
    [enabled, loading, data, error, refresh],
  );
  return <AssemblyContext.Provider value={value}>{children}</AssemblyContext.Provider>;
}

/** Shell 与统一路由边界共用同一个部署快照。 */
export function useAssemblyCapabilities(): AssemblyCapabilitiesState {
  const state = useContext(AssemblyContext);
  if (!state) throw new Error("AssemblyCapabilitiesProvider 未装配");
  return state;
}
