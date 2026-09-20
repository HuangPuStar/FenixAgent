/**
 * Meta Agent API 路由。
 *
 * POST /web/meta-agent/ensure — 查找或创建 meta environment + spawn 实例
 */

import { EnsureMetaAgentResponseSchema, ensureMetaEnvironment } from "@fenix/agent-config/server";
import { rotateCallerApiKey } from "@fenix/identity/server";
import { createLogger } from "@fenix/logger";
import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";

const logger = createLogger("meta-agent");

// agent-config 不得依赖 `@fenix/identity`，meta key 的轮换编排由身份侧实现、宿主注入。
const metaAgentDeps = { rotateCallerApiKey };

const app = new Elysia({ name: "web-meta-agent" }).use(authGuardPlugin).model({
  "ensure-meta-agent-response": EnsureMetaAgentResponseSchema,
});

app.post(
  "/meta-agent/ensure",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, request, error }: any) => {
    const authCtx = store.authContext!;
    if (!authCtx) {
      return error(401, { success: false, error: { code: "UNAUTHORIZED", message: "No organization context" } });
    }

    try {
      const result = await ensureMetaEnvironment(authCtx, request, metaAgentDeps);
      return { success: true, data: result };
    } catch (err: unknown) {
      logger.error("ensure failed:", err);
      return error(500, {
        success: false,
        error: { code: "INTERNAL_ERROR", message: "Internal server error" },
      });
    }
  },
  {
    sessionAuth: true,
    response: {
      200: "ensure-meta-agent-response",
      401: WebErrSchema,
      500: WebErrSchema,
    },
    detail: {
      tags: ["Meta Agent"],
      summary: "确保 Meta Agent 可用",
      description: "查找或创建 Meta Agent 对应的环境，并尽可能拉起一个可用实例。",
    },
  },
);

export default app;
