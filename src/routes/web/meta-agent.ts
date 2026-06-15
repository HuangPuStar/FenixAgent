/**
 * Meta Agent API 路由。
 *
 * POST /web/meta-agent/ensure — 查找或创建 meta environment + spawn 实例
 */

import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { EnsureMetaAgentResponseSchema } from "../../schemas/meta-agent.schema";
import { ensureMetaEnvironment } from "../../services/meta-agent";

const logger = createLogger("meta-agent");

const app = new Elysia({ name: "web-meta-agent" }).use(authGuardPlugin).model({
  "ensure-meta-agent-response": EnsureMetaAgentResponseSchema,
});

app.post(
  "/meta-agent/ensure",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, request, error }: any) => {
    const authCtx = store.authContext!;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No organization context" } });
    }

    try {
      const result = await ensureMetaEnvironment(authCtx, request);
      return { success: true, data: result };
    } catch (err: unknown) {
      logger.error("ensure failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  {
    sessionAuth: true,
    response: "ensure-meta-agent-response",
    detail: {
      tags: ["Meta Agent"],
      summary: "确保 Meta Agent 可用",
      description: "查找或创建 Meta Agent 对应的环境，并尽可能拉起一个可用实例。",
    },
  },
);

export default app;
