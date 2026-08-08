import Elysia from "elysia";
import * as z from "zod/v4";
import { config } from "../../../config";
import { authGuardPlugin } from "../../../plugins/auth";
import { configSuccess } from "../../../services/config-utils";
import { listPoolOptions } from "../../../services/sandbox/sandbox-admin-service";

const SandboxPoolOptionSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const SandboxPoolOptionsResponseSchema = z.object({
  success: z.literal(true),
  data: z.object({
    enabled: z.boolean(),
    pools: z.array(SandboxPoolOptionSchema),
  }),
});

const app = new Elysia({ name: "web-config-sandbox-pools" }).use(authGuardPlugin);

app.get(
  "/config/sandbox-pools",
  async ({ store }) => {
    const authContext = store.authContext!;
    return configSuccess(await listPoolOptions(authContext.organizationId, config.sandboxEnabled));
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

export default app;
