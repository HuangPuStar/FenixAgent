import { WebOkSchema } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import * as z from "zod/v4";
import { getSandboxConfig } from "../../config";
import { listPoolOptions } from "../../services/sandbox-admin-service";
import type { WebSandboxRouteDependencies } from "../dependencies";

const SandboxPoolOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const SandboxPoolOptionsResponseSchema = WebOkSchema(
  z.object({
    enabled: z.boolean(),
    pools: z.array(SandboxPoolOptionSchema),
  }),
);

/**
 * `/web/config/sandbox-pools` — Agent 配置页面可选用的沙盒资源池。
 *
 * 从宿主 `apps/server/src/routes/web/config/sandbox-pools.ts` 迁入（CE 阶段 2 任务 1.3）：
 * 资源池可读性是 Sandbox 的领域规则，路由和查询属于本模块的交付物，宿主只保留挂载点。
 *
 * 改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 `macro` / `state` 是实例作用域的，
 * 父实例无法向已构造的子实例回填），因此由宿主注入 `authGuardPlugin`。
 *
 * 沙盒开关在请求时从本模块配置读取：模块加载期宿主可能尚未完成基础设施初始化。
 */
export function createWebSandboxPoolsRoutes(deps: WebSandboxRouteDependencies) {
  const app = new Elysia({ name: "web-config-sandbox-pools" }).use(deps.authGuardPlugin);

  app.get(
    "/config/sandbox-pools",
    async ({ store }) => {
      const authContext = store.authContext!;
      const { sandboxEnabled } = getSandboxConfig();
      return { success: true as const, data: await listPoolOptions(authContext.organizationId, sandboxEnabled) };
    },
    {
      sessionAuth: true,
      response: { 200: SandboxPoolOptionsResponseSchema },
      detail: {
        tags: ["Sandbox"],
        summary: "获取 Agent 配置可用的沙盒资源池",
        description: "返回当前组织可选择的全局或组织级沙盒资源池，仅返回资源池 ID 和名称。",
      },
    },
  );

  return app;
}
