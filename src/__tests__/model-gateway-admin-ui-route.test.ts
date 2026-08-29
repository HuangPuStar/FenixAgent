import { afterEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import modelGatewayRoutes from "../routes/api/system-model-gateway";
import { type ModelGatewayServices, setModelGatewayServices } from "../services/model-gateway";

const originalAdminUiUrl = config.modelGatewayAdminUiUrl;
const originalSystemApiKeys = process.env.RCS_SYSTEM_API_KEYS;

afterEach(() => {
  setConfig({ modelGatewayAdminUiUrl: originalAdminUiUrl });
  setModelGatewayServices(null);
  if (originalSystemApiKeys === undefined) delete process.env.RCS_SYSTEM_API_KEYS;
  else process.env.RCS_SYSTEM_API_KEYS = originalSystemApiKeys;
});

describe("model gateway configuration route", () => {
  // 配置接口返回部署层默认预算和管理后台地址，避免状态检查混入配置数据。
  test("returns the configured LiteLLM management URL and default budget", async () => {
    process.env.RCS_SYSTEM_API_KEYS = "system-test-key";
    setConfig({
      modelGatewayAdminUiUrl: "https://litellm.example.test/ui/",
      modelGatewayDefaultUserBudgetUsd: 50,
      modelGatewayDefaultBudgetDuration: "30d",
    });
    setModelGatewayServices({
      provider: {
        getConfiguration: async () => ({ provider: null }),
      },
    } as unknown as ModelGatewayServices);

    const response = await modelGatewayRoutes.handle(
      new Request("http://localhost/api/system/model-gateway/config", {
        headers: { Authorization: "Bearer system-test-key" },
      }),
    );

    expect(response.status).toBe(200);
    const payload = await new Response(response.body).json();
    expect(payload).toEqual({
      provider: null,
      adminUiUrl: "https://litellm.example.test/ui/",
      defaultBudget: { maxBudgetUsd: 50, duration: "30d" },
    });
  });
});
