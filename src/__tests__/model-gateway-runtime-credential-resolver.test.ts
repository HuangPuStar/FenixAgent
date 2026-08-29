import { describe, expect, test } from "bun:test";
import { createModelGatewayRuntimeCredentialResolver } from "../services/model-gateway/runtime-credential-resolver";

describe("model gateway runtime credential resolver", () => {
  // 预算已用尽时拒绝解析或创建动态 Key，避免 Agent 带着无效凭证启动。
  test("用户预算耗尽时返回预算耗尽状态", async () => {
    let resolveCredentialCalled = false;
    const resolve = createModelGatewayRuntimeCredentialResolver({
      getUserBudget: async () => ({ maxBudgetUsd: 1, duration: "30d", spendUsd: 1, resetAt: null }),
      resolveCredential: async () => {
        resolveCredentialCalled = true;
        return { internalUserId: "fenix-user-1", externalCredentialId: "key-1", secret: "secret" };
      },
    });

    await expect(
      resolve({
        gatewayProviderId: "gateway-1",
        organizationId: "org-1",
        userId: "user-1",
        agentConfigId: "agent-1",
      }),
    ).resolves.toEqual({ status: "budget-exhausted" });
    expect(resolveCredentialCalled).toBeFalse();
  });
});
