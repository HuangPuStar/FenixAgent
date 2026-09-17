import { resetRouteConfigDepsForTesting, setRouteConfigDepsForTesting } from "@fenix/agent-config/server/testing";
import { getConfigPgStub } from "./helpers";

type RouteConfigStubs = Parameters<typeof setRouteConfigDepsForTesting>[0];
type ConfigStubName = Parameters<typeof getConfigPgStub>[0];

const routeConfigStubs = new Proxy({} as RouteConfigStubs, {
  get: (_target, property) => {
    if (typeof property !== "string") return;
    const stubName = property as ConfigStubName;
    const stub = getConfigPgStub(stubName);
    if (typeof stub !== "function") {
      throw new Error(`config service stub '${property}' must be callable in route tests`);
    }
    return (...args: unknown[]) => stub(...args);
  },
});

/** 将既有 ConfigPg stub 注册表接入迁移后的 AgentConfig 路由。 */
export function installRouteConfigStubs(): void {
  setRouteConfigDepsForTesting(routeConfigStubs);
}

/** 每个路由用例结束后恢复真实领域依赖，避免跨文件泄漏。 */
export function resetRouteConfigStubs(): void {
  resetRouteConfigDepsForTesting();
}
