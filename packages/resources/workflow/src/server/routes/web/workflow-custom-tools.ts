/**
 * Custom Tools 查询路由。
 *
 * GET /web/workflow-custom-tools — 返回当前服务注册的所有 CustomNode 工具元数据。
 * 数据源：getCustomToolsRegistry().list()，全局共享，不按 organizationId 隔离
 * （tool 定义本身是全局的；按 org 隔离的是 WorkflowEngine 实例和 storage）。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，
 * 父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 */

import Elysia from "elysia";
import { getCustomToolsRegistry } from "../../services/workflow/custom-tools";
import type { WorkflowRouteDependencies } from "../dependencies";

/** 创建 `/web/workflow-custom-tools` 路由。 */
export function createWebWorkflowCustomToolsRoutes(deps: WorkflowRouteDependencies) {
  return new Elysia({ name: "web-workflow-custom-tools" }).use(deps.authGuardPlugin).get(
    "/workflow-custom-tools",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation
    async ({ store }: any) => {
      // authGuardPlugin 保证登录；未登录走 401 拦截，不会到此处
      void store.authContext;
      const registry = getCustomToolsRegistry();
      const tools = registry.list();
      return { success: true, data: tools };
    },
    {
      sessionAuth: true,
      detail: {
        tags: ["Workflow Engine"],
        summary: "列出已注册的自定义节点工具",
        description:
          "返回 WORKFLOW_TOOLS_DIR 下注册的所有 CustomNode 工具元数据（name/description/inputs/produces），供前端 palette 和节点配置下拉使用。",
      },
    },
  );
}
