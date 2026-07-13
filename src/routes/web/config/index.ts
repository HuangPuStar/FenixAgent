import Elysia from "elysia";
import agents from "./agents";
import mcp from "./mcp";
import models from "./models";
import prodViews from "./prod-views";
import providers from "./providers";
import skills from "./skills";

const app = new Elysia({ name: "web-config" })
  .use(providers)
  .use(models)
  .use(agents)
  .use(skills)
  .use(mcp)
  .use(prodViews);

export default app;
