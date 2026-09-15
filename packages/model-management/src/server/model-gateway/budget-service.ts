import {
  type GatewayBudget,
  type GatewayBudgetConfig,
  type ModelGatewayAdapter,
  ModelGatewayError,
} from "@fenix/model-gateway-sdk";
import { stableInternalUserId } from "./credential-service";

export interface BudgetUpdateResult {
  userId: string;
  status: "updated" | "failed";
  budget?: GatewayBudget;
  error?: string;
}

export interface ModelGatewayBudgetServiceDeps {
  adapter: ModelGatewayAdapter;
  concurrency?: number;
  defaultBudget?: GatewayBudgetConfig;
}

/**
 * 全局用户预算服务。
 *
 * LiteLLM 是预算事实来源，Fenix 不保存预算副本；批量更新是多个远端操作，
 * 因此按用户返回结果而不是伪造一个可回滚的分布式事务。
 */
export function createModelGatewayBudgetService(deps: ModelGatewayBudgetServiceDeps) {
  const concurrency = Math.max(1, deps.concurrency ?? 5);

  async function updateUserBudget(
    gatewayProviderId: string,
    userId: string,
    budget: GatewayBudgetConfig,
  ): Promise<BudgetUpdateResult> {
    const externalUserId = stableInternalUserId(gatewayProviderId, userId);
    // 未使用过网关的用户尚未有 LiteLLM Internal User，先以本次预算完成幂等创建。
    await deps.adapter.ensureUser({ externalId: externalUserId, budget });
    const updated = await deps.adapter.updateUserBudget({
      externalUserId,
      maxBudgetUsd: budget.maxBudgetUsd,
      duration: budget.duration,
    });
    return { userId, status: "updated", budget: updated };
  }

  /** 读取已激活用户的 LiteLLM 预算；尚未创建网关账户时返回空。 */
  async function getUserBudget(gatewayProviderId: string, userId: string): Promise<GatewayBudget | null> {
    try {
      return await deps.adapter.getUserBudget(stableInternalUserId(gatewayProviderId, userId));
    } catch (error) {
      if (error instanceof ModelGatewayError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async function bulkUpdateUserBudgets(
    gatewayProviderId: string,
    userIds: string[],
    budget: GatewayBudgetConfig,
  ): Promise<{
    succeeded: Array<{ userId: string; status: "updated" }>;
    failed: Array<{ userId: string; status: "failed"; error?: string }>;
  }> {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length > 100) throw new Error("at most 100 users can be updated at once");

    const succeeded: Array<{ userId: string; status: "updated" }> = [];
    const failed: Array<{ userId: string; status: "failed"; error?: string }> = [];
    let nextIndex = 0;
    async function worker() {
      while (true) {
        const index = nextIndex++;
        const userId = uniqueUserIds[index];
        if (!userId) return;
        try {
          const result = await updateUserBudget(gatewayProviderId, userId, budget);
          succeeded.push({ userId: result.userId, status: "updated" });
        } catch (error) {
          failed.push({
            userId,
            status: "failed",
            error: error instanceof Error ? error.message : "budget update failed",
          });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, uniqueUserIds.length) }, () => worker()));
    succeeded.sort((a, b) => a.userId.localeCompare(b.userId));
    failed.sort((a, b) => a.userId.localeCompare(b.userId));
    return { succeeded, failed };
  }

  /** 批量清零已有 LiteLLM Internal User 的消耗，不创建尚未使用网关的用户。 */
  async function resetUserBudgets(gatewayProviderId: string, userIds: string[]) {
    const uniqueUserIds = [...new Set(userIds)];
    if (uniqueUserIds.length > 100) throw new Error("at most 100 users can be reset at once");
    if (!deps.adapter.resetUserBudgets) throw new Error("gateway does not support resetting user budgets");

    const externalUserIds = uniqueUserIds.map((userId) => stableInternalUserId(gatewayProviderId, userId));
    const userIdByExternalUserId = new Map(
      externalUserIds.map((externalUserId, index) => [externalUserId, uniqueUserIds[index]!]),
    );
    const result = await deps.adapter.resetUserBudgets(externalUserIds);
    return {
      succeeded: result.succeededExternalUserIds.flatMap((externalUserId) => {
        const userId = userIdByExternalUserId.get(externalUserId);
        return userId ? [{ userId, status: "updated" as const }] : [];
      }),
      failed: result.failed.flatMap(({ externalUserId, error }) => {
        const userId = userIdByExternalUserId.get(externalUserId);
        return userId ? [{ userId, status: "failed" as const, error }] : [];
      }),
    };
  }

  async function listUserBudgets(gatewayProviderId: string, users: Array<{ id: string; name: string; email: string }>) {
    const externalUserIds = users.map((user) => stableInternalUserId(gatewayProviderId, user.id));
    const budgetsByExternalUserId = new Map(
      (await deps.adapter.listUserBudgets(externalUserIds)).map((budget) => [budget.externalUserId, budget]),
    );
    return users.map((user) => {
      const budget = budgetsByExternalUserId.get(stableInternalUserId(gatewayProviderId, user.id));
      if (budget)
        return {
          ...user,
          budget,
          source: "litellm" as const,
          isActivated: true,
        };
      return {
        ...user,
        budget: {
          maxBudgetUsd: deps.defaultBudget?.maxBudgetUsd ?? null,
          duration: deps.defaultBudget?.duration ?? null,
          spendUsd: 0,
          resetAt: null,
        },
        source: "default" as const,
        isActivated: false,
      };
    });
  }

  return {
    updateUserBudget,
    getUserBudget,
    bulkUpdateUserBudgets,
    resetUserBudgets,
    listUserBudgets,
  };
}
