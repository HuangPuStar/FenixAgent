import * as configServices from "../services/config";

type RouteConfigDeps = typeof configServices;

let testOverrides: Partial<RouteConfigDeps> | null = null;

/**
 * 路由层通过稳定代理读取 AgentConfig 服务。
 *
 * 生产环境始终返回领域实现；测试可以替换依赖而不污染直接导入领域实现的用例。
 */
export const routeConfigDeps = new Proxy({} as RouteConfigDeps, {
  get: (_target, property) => {
    if (typeof property !== "string") return undefined;
    const key = property as keyof RouteConfigDeps;
    return testOverrides?.[key] ?? configServices[key];
  },
});

/** 仅供同包路由测试替换协议层依赖。 */
export function setRouteConfigDepsForTesting(overrides: Partial<RouteConfigDeps>): void {
  testOverrides = overrides;
}

/** 清除路由测试依赖，防止跨测试文件共享状态。 */
export function resetRouteConfigDepsForTesting(): void {
  testOverrides = null;
}
