import { webConfigAgentsRoutes as agents } from "@fenix/agent-config/server";
import { webConfigModelsRoutes as models, webConfigProvidersRoutes as providers } from "@fenix/model-management/server";
import { webMcpConfigRoutes as mcp } from "@fenix/resource-mcp/server";
import { webConfigProdViewsRoutes as prodViews } from "@fenix/resource-prod-view/server";
import { createWebSandboxPoolsRoutes } from "@fenix/resource-sandbox/server";
import { webSkillsConfigRoutes as skills } from "@fenix/resource-skill/server";
import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";

// 沙盒资源池路由改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 macro / state 是实例
// 作用域的，父实例无法向已构造的子实例回填），因此在这里注入而不是让包自建。
const sandboxPools = createWebSandboxPoolsRoutes({ authGuardPlugin });

const app = new Elysia({ name: "web-config" })
  .use(providers)
  .use(sandboxPools)
  .use(models)
  .use(agents)
  .use(skills)
  .use(mcp)
  .use(prodViews);

export default app;
