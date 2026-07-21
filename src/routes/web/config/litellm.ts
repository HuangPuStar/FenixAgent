import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { authGuardPlugin } from "../../../plugins/auth";
import { configError, configSuccess } from "../../../services/config-utils";
import { getLitellmClient, getUsageReport, isLitellmConfigured } from "../../../services/litellm";

const logger = createLogger("litellm");

const app = new Elysia({ name: "web-config-litellm" })
  .get(
    "/config/litellm/status",
    async () => {
      const configured = isLitellmConfigured();
      if (!configured) {
        return configSuccess({ configured: false, available: false });
      }

      let available = false;
      try {
        const { baseUrl } = getLitellmClient();
        const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(5000) });
        available = res.ok;
      } catch (_err) {
        logger.warn("LiteLLM health check failed");
      }

      return configSuccess({ configured: true, available });
    },
    {
      detail: {
        summary: "查询 LiteLLM 服务可用状态",
        description: "返回 LiteLLM 是否已配置及当前是否可达。前端据此决定是否显示 LiteLLM 协议选项。",
      },
    },
  )
  .use(authGuardPlugin)
  // GET /config/litellm/usage?days=7 — 按 agent 聚合的用量报表
  .get(
    "/config/litellm/usage",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia store/query type inference limitation
    async ({ store, query }: any) => {
      const authCtx = store.authContext;
      if (!authCtx) {
        return configError("UNAUTHORIZED", "Authentication required");
      }

      if (!isLitellmConfigured()) {
        return configError("NOT_CONFIGURED", "LiteLLM client not initialized");
      }

      const rawDays = typeof query?.days === "string" ? query.days : "7";
      const days = Math.max(1, Math.min(365, Number.parseInt(rawDays, 10) || 7));

      try {
        const report = await getUsageReport(authCtx.organizationId, days, authCtx.userId);
        return configSuccess(report);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error("Failed to fetch usage report:", message);
        return configError("LITELLM_USAGE_ERROR", message);
      }
    },
    {
      sessionAuth: true,
      detail: {
        summary: "查询 LiteLLM 用量报表",
        description:
          "按 agent 聚合当前组织下所有 LiteLLM Key 的用量数据，支持 days 参数控制查询天数（1-365，默认 7）。",
        parameters: [
          {
            name: "days",
            in: "query",
            required: false,
            description: "查询最近 N 天的用量，默认 7，最大 365",
            schema: { type: "string" },
          },
        ],
      },
    },
  );

export default app;
