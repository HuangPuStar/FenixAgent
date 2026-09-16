import { webConfigAgentsRoutes as agents } from "@fenix/agent-config/server";
import { webMcpConfigRoutes as mcp } from "@fenix/resource-mcp/server";
import { webSkillsConfigRoutes as skills } from "@fenix/resource-skill/server";
import Elysia from "elysia";
import models from "./models";
import prodViews from "./prod-views";
import providers from "./providers";
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
