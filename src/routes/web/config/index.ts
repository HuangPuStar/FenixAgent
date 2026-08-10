import Elysia from "elysia";
import agentExperts from "./agent-experts";
import agents from "./agents";
import mcp from "./mcp";
import models from "./models";
import prodViews from "./prod-views";
import providers from "./providers";
import sandboxPools from "./sandbox-pools";
import skills from "./skills";

const app = new Elysia({ name: "web-config" })
  .use(providers)
  .use(sandboxPools)
  .use(models)
  .use(agents)
  .use(agentExperts)
  .use(skills)
  .use(mcp)
  .use(prodViews);

export default app;
