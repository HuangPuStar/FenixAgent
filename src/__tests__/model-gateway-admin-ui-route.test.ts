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

  // 验证系统管理员可读取实时 Key 可用性，但响应不会包含任何 Key 明文。
  test("lists Fenix-managed keys with the current invalid reason", async () => {
    process.env.RCS_SYSTEM_API_KEYS = "system-test-key";
    setModelGatewayServices({
      provider: { ensureProvider: async () => "provider-1" },
      keyManagement: {
        listKeys: async () => ({
          items: [
            {
              id: "a0000000-0000-4000-8000-000000000001",
              externalCredentialId: "key-id-only",
              encryptedCredential: "encrypted-key",
              organizationId: "org-1",
              organizationName: "Organization One",
              userId: "user-1",
              userName: "User One",
              agentConfigId: "a0000000-0000-4000-8000-000000000002",
              agentName: "Agent One",
              status: "active" as const,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              usable: false,
              invalidReason: "AGENT_ACCESS_REVOKED" as const,
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      },
    } as unknown as ModelGatewayServices);

    const response = await modelGatewayRoutes.handle(
      new Request("http://localhost/api/system/model-gateway/keys?page=1&pageSize=20", {
        headers: { Authorization: "Bearer system-test-key" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(new Response(response.body).json()).resolves.toMatchObject({
      items: [{ externalCredentialId: "key-id-only", invalidReason: "AGENT_ACCESS_REVOKED", usable: false }],
      total: 1,
    });
  });
});
