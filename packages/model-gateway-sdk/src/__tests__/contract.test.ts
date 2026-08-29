import { describe, expect, test } from "bun:test";
import type { GatewayBudget, ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import { ModelGatewayError } from "@fenix/model-gateway-sdk";

describe("Model Gateway SDK contract", () => {
  // 验证不同网关实现可以通过统一且与供应商无关的 Adapter 契约接入。
  test("exports a gateway-neutral adapter contract", () => {
    const adapter: ModelGatewayAdapter = {
      type: "fake",
      checkHealth: async () => ({ status: "healthy" }),
      listModels: async () => [],
      ensureUser: async () => ({ externalId: "user-1" }),
      getUserBudget: async () => ({
        maxBudgetUsd: null,
        duration: null,
        spendUsd: 0,
        resetAt: null,
      }),
      listUserBudgets: async () => [],
      updateUserBudget: async () => ({
        maxBudgetUsd: 50,
        duration: null,
        spendUsd: 0,
        resetAt: null,
      }),
      createCredential: async () => ({
        externalId: "key-1",
        secret: "secret",
      }),
      blockCredential: async () => undefined,
      queryUsage: async () => ({ totalSpendUsd: 0, records: [] }),
    };

    expect(adapter.type).toBe("fake");
    expect(ModelGatewayError).toBeDefined();
  });

  // 验证 null duration 明确表达一次性预算，而不是把一次性预算伪装成长期周期。
  test("represents a one-time budget with null duration", () => {
    const budget: GatewayBudget = {
      maxBudgetUsd: 50,
      duration: null,
      spendUsd: 0,
      resetAt: null,
    };

    expect(budget.duration).toBeNull();
  });
});
