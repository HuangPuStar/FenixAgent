/**
 * Workflow Statistics API 路由。
 *
 * POST /web/workflow-stats — action 分发，聚合查询工作流运行统计。
 */

import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  getDailyTokens,
  getDailyTrend,
  getRecentFailedRuns,
  getStatsOverview,
} from "../../repositories/workflow-stats";

const logger = createLogger("wf-stats");

const app = new Elysia({ name: "web-workflow-stats" }).use(authGuardPlugin);

app.post(
  "/workflow-stats",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;
    const range = payload.range as string;

    let since: Date | undefined;
    if (range === "7d") since = new Date(Date.now() - 7 * 86400000);
    else if (range === "30d") since = new Date(Date.now() - 30 * 86400000);

    try {
      switch (action) {
        case "overview": {
          const data = await getStatsOverview(authCtx.organizationId, since);
          return { success: true, data };
        }
        case "trend": {
          const data = await getDailyTrend(authCtx.organizationId, since ?? new Date(Date.now() - 30 * 86400000));
          return { success: true, data };
        }
        case "tokens": {
          const data = await getDailyTokens(authCtx.organizationId, since ?? new Date(Date.now() - 30 * 86400000));
          return { success: true, data };
        }
        case "failedRuns": {
          const data = await getRecentFailedRuns(authCtx.organizationId);
          return { success: true, data };
        }
        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      logger.error("Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
