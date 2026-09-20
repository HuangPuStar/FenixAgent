import type { McpServerServerModule } from "./module";

/**
 * MCP 资源模块的进程级装配结果。
 *
 * 宿主启动流程调用 `createMcpServerServerModule` 后经 {@link installMcpServerModule} 装入；路由与
 * 系统路径（Hindsight 托管服务器写入）都在调用时读取它，测试可整体替换为替身。
 *
 * 未装配时 {@link getMcpServerModule} 直接报错：静默退化会让所有 MCP 端点以"资源不存在"响应，
 * 把装配故障伪装成业务结果。
 *
 * 本文件是包导出面 `./server/runtime` 的入口：宿主只需要装配结果与配置类型时从这里导入，不要经
 * `./server` barrel——barrel 会连带导出 HTTP 路由，把 agent-runtime 及其宿主依赖拉进导入方所在的
 * 依赖图（`apps/server/src/services/config/mcp-system-server.ts` 曾因此在宿主服务与资源包之间
 * 形成环，见 `scripts/architecture/exceptions.json` 的 no-circular 说明）。
 */

export type { McpServerConfig } from "./services/config/mcp-config";

let installed: McpServerServerModule | null = null;

/** 装入装配结果；由宿主启动流程调用，测试用同一入口注入替身。 */
export function installMcpServerModule(module: McpServerServerModule): void {
  installed = module;
}

/** 读取装配结果；未装配即报错，不做兜底实现。 */
export function getMcpServerModule(): McpServerServerModule {
  if (!installed) {
    throw new Error("MCP 资源模块未装配：宿主启动流程必须先装配 access-control 与身份目录");
  }
  return installed;
}

/** 清除装配结果，防止跨测试文件共享状态。 */
export function resetMcpServerModule(): void {
  installed = null;
}
