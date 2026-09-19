import { webConfigAgentsRoutes as agents } from "@fenix/agent-config/server";
import { webConfigModelsRoutes as models, webConfigProvidersRoutes as providers } from "@fenix/model-management/server";
import { webMcpConfigRoutes as mcp } from "@fenix/resource-mcp/server";
import { webConfigProdViewsRoutes as prodViews } from "@fenix/resource-prod-view/server";
import { webSkillsConfigRoutes as skills } from "@fenix/resource-skill/server";
import Elysia from "elysia";
import sandboxPools from "./sandbox-pools";

const app = new Elysia({ name: "web-config" })
  .use(providers)
  .use(sandboxPools)
  .use(models)
  .use(agents)
  .use(skills)
  .use(mcp)
  .use(prodViews);

export default app;
