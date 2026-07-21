import { createLogger } from "@fenix/logger";
import Elysia from "elysia";
import { configSuccess } from "../../../services/config-utils";
import { getLitellmClient, isLitellmConfigured } from "../../../services/litellm";

const logger = createLogger("litellm-status");

const app = new Elysia({ name: "web-config-litellm" }).get(
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
);

export default app;
