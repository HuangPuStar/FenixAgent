import { createWebConfigAgentsRoutes } from "@fenix/agent-config/server";
import { createWebConfigModelsRoutes, createWebConfigProvidersRoutes } from "@fenix/model-management/server";
import { createWebMcpConfigRoutes } from "@fenix/resource-mcp/server";
import { createWebConfigProdViewsRoutes } from "@fenix/resource-prod-view/server";
import { createWebSandboxPoolsRoutes } from "@fenix/resource-sandbox/server";
import { createWebSkillsConfigRoutes } from "@fenix/resource-skill/server";
import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import {
  resolveSecretReference,
  userAgentPreferences,
  userModelPreferences,
} from "../../../services/resource-module-ports";

// 资源包路由一律改为工厂：守卫必须与宿主的认证解析是同一份实例、偏好端口必须落在身份族的
// `user_config` 表上（Elysia 的 macro / state 是实例作用域的，父实例无法向已构造的子实例回填），
// 因此在这里注入而不是让包自建。端口实现见 `services/resource-module-ports.ts`。
const providers = createWebConfigProvidersRoutes({ authGuardPlugin, resolveSecretReference });
const sandboxPools = createWebSandboxPoolsRoutes({ authGuardPlugin });
const models = createWebConfigModelsRoutes({ authGuardPlugin, userModelPreferences });
const agents = createWebConfigAgentsRoutes({ authGuardPlugin, userAgentPreferences });
const skills = createWebSkillsConfigRoutes({ authGuardPlugin });
const mcp = createWebMcpConfigRoutes({ authGuardPlugin });
const prodViews = createWebConfigProdViewsRoutes({ authGuardPlugin });

const app = new Elysia({ name: "web-config" })
  .use(providers)
  .use(sandboxPools)
  .use(models)
  .use(agents)
  .use(skills)
  .use(mcp)
  .use(prodViews);

export default app;
