import { describe, expect, test } from "bun:test";
import type { ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import { createModelGatewayBudgetService } from "../services/model-gateway/budget-service";
import { stableInternalUserId } from "../services/model-gateway/credential-service";

function createAdapter() {
  const updates: string[] = [];
  const adapter: ModelGatewayAdapter = {
    type: "litellm",
    checkHealth: async () => ({ status: "healthy" }),
    listModels: async () => [],
    ensureUser: async () => ({ externalId: "internal-user" }),
    getUserBudget: async () => ({
      maxBudgetUsd: null,
      duration: null,
      spendUsd: 0,
      resetAt: null,
    }),
    listUserBudgets: async () => [],
    updateUserBudget: async ({ externalUserId, maxBudgetUsd, duration }) => {
      updates.push(`${externalUserId}:${maxBudgetUsd}:${duration ?? "once"}`);
      if (externalUserId === stableInternalUserId("gateway-1", "user-2")) throw new Error("remote update failed");
      return { maxBudgetUsd, duration, spendUsd: 2, resetAt: null };
    },
    createCredential: async () => ({ externalId: "key", secret: "secret" }),
    blockCredential: async () => {},
    queryUsage: async () => ({ totalSpendUsd: 0, records: [] }),
  };
  return { adapter, updates };
}

describe("model gateway budget service", () => {
  // 验证单用户预算更新使用全局 Internal User，并保留一次性预算语义。
  test("预算更新使用稳定 Internal User，且一次性预算传递为 null", async () => {
    const { adapter, updates } = createAdapter();
    const service = createModelGatewayBudgetService({ adapter });

    const result = await service.updateUserBudget("gateway-1", "user-1", {
      maxBudgetUsd: 50,
      duration: null,
    });

    expect(result.status).toBe("updated");
    expect(result.budget?.duration).toBeNull();
    expect(updates).toEqual([`${stableInternalUserId("gateway-1", "user-1")}:50:once`]);
  });

  // 验证批量预算更新去重、限量、并发和部分失败结果。
  test("批量预算去重、最多 100 人，并发执行且逐项返回失败", async () => {
    const { adapter, updates } = createAdapter();
    const service = createModelGatewayBudgetService({
      adapter,
      concurrency: 5,
    });

    const result = await service.bulkUpdateUserBudgets("gateway-1", ["user-1", "user-1", "user-2"], {
      maxBudgetUsd: 20,
      duration: "7d",
    });

    expect(result).toEqual({
      succeeded: [{ userId: "user-1", status: "updated" }],
      failed: [{ userId: "user-2", status: "failed", error: "remote update failed" }],
    });
    expect(updates).toHaveLength(2);
  });

  // 验证批量更新超出服务端保护上限时不会触发远端写入。
  test("批量更新超过 100 人时拒绝请求且不调用网关", async () => {
    const { adapter, updates } = createAdapter();
    const service = createModelGatewayBudgetService({ adapter });

    await expect(
      service.bulkUpdateUserBudgets(
        "gateway-1",
        Array.from({ length: 101 }, (_, index) => `user-${index}`),
        { maxBudgetUsd: 20, duration: "30d" },
      ),
    ).rejects.toThrow("at most 100 users");
    expect(updates).toEqual([]);
  });

  // 验证批量重置将 Fenix 用户映射为 Internal User，并保留 LiteLLM 的逐项失败。
  test("批量重置预算通过单次网关请求清零已选用户消耗", async () => {
    const { adapter } = createAdapter();
    const requestedExternalUserIds: string[] = [];
    const adapterWithReset = adapter as unknown as {
      resetUserBudgets: (externalUserIds: string[]) => Promise<{
        succeededExternalUserIds: string[];
        failed: Array<{ externalUserId: string; error?: string }>;
      }>;
    };
    adapterWithReset.resetUserBudgets = async (externalUserIds) => {
      requestedExternalUserIds.push(...externalUserIds);
      return {
        succeededExternalUserIds: [externalUserIds[0]!],
        failed: [{ externalUserId: externalUserIds[1]!, error: "not found" }],
      };
    };
    const service = createModelGatewayBudgetService({ adapter });

    const result = await (
      service as unknown as {
        resetUserBudgets: (gatewayProviderId: string, userIds: string[]) => Promise<unknown>;
      }
    ).resetUserBudgets("gateway-1", ["user-1", "user-2"]);

    expect(requestedExternalUserIds).toEqual([
      stableInternalUserId("gateway-1", "user-1"),
      stableInternalUserId("gateway-1", "user-2"),
    ]);
    expect(result).toEqual({
      succeeded: [{ userId: "user-1", status: "updated" }],
      failed: [{ userId: "user-2", status: "failed", error: "not found" }],
    });
  });

  // 验证尚未在 LiteLLM 创建 Internal User 的用户只返回默认预算预览，不能被当作已生效限额。
  test("未创建网关账户的用户返回未生效的默认预算预览", async () => {
    const { adapter } = createAdapter();
    const service = createModelGatewayBudgetService({
      adapter,
      defaultBudget: { maxBudgetUsd: 100, duration: "30d" },
    });

    const [item] = await service.listUserBudgets("gateway-1", [
      { id: "user-1", name: "Pending user", email: "pending@example.com" },
    ]);

    expect(item).toMatchObject({
      source: "default",
      isActivated: false,
      budget: {
        maxBudgetUsd: 100,
        duration: "30d",
        spendUsd: 0,
        resetAt: null,
      },
    });
  });

  // 验证预算列表按稳定 Internal User ID 匹配 LiteLLM 列表项，不再逐用户读取详情。
  test("从 LiteLLM 用户列表匹配已生效的用户预算", async () => {
    const { adapter } = createAdapter();
    let requestedUserIds: readonly string[] | undefined;
    adapter.listUserBudgets = async (externalUserIds) => {
      requestedUserIds = externalUserIds;
      return [
        {
          externalUserId: stableInternalUserId("gateway-1", "user-1"),
          maxBudgetUsd: 100,
          duration: "30d",
          spendUsd: 12.5,
          resetAt: "2026-09-01T00:00:00Z",
        },
      ];
    };
    const service = createModelGatewayBudgetService({ adapter });

    const [item] = await service.listUserBudgets("gateway-1", [
      { id: "user-1", name: "Active user", email: "active@example.com" },
    ]);

    expect(item).toMatchObject({
      source: "litellm",
      isActivated: true,
      budget: {
        maxBudgetUsd: 100,
        duration: "30d",
        spendUsd: 12.5,
        resetAt: "2026-09-01T00:00:00Z",
      },
    });
    expect(requestedUserIds).toEqual([stableInternalUserId("gateway-1", "user-1")]);
  });
});
