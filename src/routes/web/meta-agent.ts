/**
 * Meta Agent API 路由。
 *
 * POST /web/meta-agent/ensure — 查找或创建 meta environment + spawn 实例
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { ensureMetaEnvironment } from "../../services/meta-agent";

const app = new Elysia({ name: "web-meta-agent", prefix: "/web" }).use(authGuardPlugin);

app.post(
  "/meta-agent/ensure",
  async ({ store, request, error }: any) => {
    const authCtx = store.authContext!;
    if (!authCtx) {
      return error(401, { error: { type: "UNAUTHORIZED", message: "No organization context" } });
    }

    try {
      const result = await ensureMetaEnvironment(authCtx, request);
      return { success: true, data: result };
    } catch (err: unknown) {
      console.error("[meta-agent] ensure failed:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
